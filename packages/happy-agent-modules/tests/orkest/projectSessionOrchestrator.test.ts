import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    ORKEST_SESSION_TOOLS,
    OrkestSessionClient,
    type OrkestSessionAnswer,
    type OrkestSessionCall,
} from "../../sources/orkest/impl/OrkestSessionClient.js";
import { deliverProjectSessionNotes, noteLine } from "../../sources/orkest/impl/projectSessionNotes.js";
import { projectSessionTools } from "../../sources/orkest/impl/projectSessionTools.js";
import { writeWorkingCopy } from "../../sources/orkest/impl/projectSessionWorkspace.js";

// GHO-199.4.1 — the Happy adapter as the project session's orchestrator (orkest docs/design/orkest-project-session.md
// section 3): a project session's agent gets the run and ticket tools, which ask the person; it never gets a tool to
// answer for them; its change notes and the person's quick actions arrive as messages on the heartbeat.

const CALL: OrkestSessionCall = { session: "0b9c5a52-6f1e-4d0f-9a1b-8b3c2d1e0f11", fence: 7, projectId: "4c2b1a0e-1111-4222-8333-944455556666" };
const CHILD = "c1c1c1c1-0000-4000-8000-000000000001";
const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fakeClient(reply: (name: string, args: Record<string, unknown>) => OrkestSessionAnswer) {
    const seen: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
        tool: async (name: string, _call: OrkestSessionCall, args: Record<string, unknown>) => {
            seen.push({ name, args });
            return reply(name, args);
        },
        propose: async () => reply("propose", {}),
    } as unknown as OrkestSessionClient;
    return { client, seen };
}

async function toolsFor(client: OrkestSessionClient, scopeKind: "project" | "doc", permissionMode = "workspace_write") {
    const taskPath = await mkdtemp(join(tmpdir(), "happy-ps6-"));
    dirs.push(taskPath);
    return {
        taskPath,
        tools: projectSessionTools({
            client, call: () => CALL, taskPath, taskId: "task-1", agentHome: join(taskPath, "no-home"), agentId: "agent-1",
            permissionMode, model: () => "synthetic-model", turn: async () => "t1", scopeKind,
        } as never),
    };
}
const run = async (tools: readonly { name: string; execute: unknown }[], name: string, args: Record<string, unknown>) =>
    (await (tools.find((t) => t.name === name)! as { execute: (c: Context, a: unknown, o: never) => Promise<unknown> })
        .execute({} as Context, args, {} as never)) as string;

describe("the orchestrator tools", () => {
    it("a project session gets them; a doc session does not; there is no answer tool", async () => {
        const { client } = fakeClient(() => ({ ok: true, status: 200, body: {} }));
        const names = (await toolsFor(client, "project")).tools.map((t) => t.name);
        for (const n of ["start_run", "propose_ticket", "stop_run", "list_children", "list_requests", "read_notes", "ack_notes", "reconcile_roadmap"])
            expect(names).toContain(n);
        for (const n of ["approve", "reject", "answer_request", "answer_approval", "decide"]) {
            expect(names).not.toContain(n);
            expect(ORKEST_SESSION_TOOLS as readonly string[]).not.toContain(n);
        }
        const doc = (await toolsFor(client, "doc")).tools.map((t) => t.name);
        expect(doc).not.toContain("start_run");
        expect(doc).toContain("read_doc");
        await expect(new OrkestSessionClient({ url: "http://127.0.0.1:1", workerToken: "x" }).tool("approve", CALL, {})).rejects.toThrow(/unknown session tool/);
    });

    it("start_run asks the person and says it waits on their card", async () => {
        const { client, seen } = fakeClient(() => ({
            ok: true, status: 200, body: { state: "held", request: "r1", sentence: "Project chat wants to start an unattended run on GHO-1, because red" },
        }));
        const text = await run((await toolsFor(client, "project")).tools, "start_run", { ticket: "GHO-1", mode: "afk", why: "red" });
        expect(seen).toEqual([{ name: "start_run", args: { ticket: "GHO-1", mode: "afk", why: "red" } }]);
        expect(text).toMatch(/waits on their card/);
        expect(text).toMatch(/cannot answer it/);
    });

    it("a read-only session is told so before anything is sent; refusals are plain words", async () => {
        const { client, seen } = fakeClient(() => ({ ok: false, status: 404, error: "ORKEST_SESSION_NOT_A_CHILD" }));
        expect(await run((await toolsFor(client, "project", "read_only")).tools, "start_run", { ticket: "GHO-1", mode: "afk", why: "r" })).toMatch(/read only/);
        expect(seen).toEqual([]);
        expect(await run((await toolsFor(client, "project")).tools, "stop_run", { runId: CHILD })).toMatch(/not started by this chat/);
    });

    it("a roadmap proposal refused for evidence or the check says what to fix", async () => {
        const { client } = fakeClient(() => ({ ok: false, status: 409, error: "done_without_evidence", data: { nodes: ["track"] } }));
        const { tools, taskPath } = await toolsFor(client, "project");
        await writeWorkingCopy(taskPath, "docs/ROADMAP.md", "# Roadmap\n", "a".repeat(40));
        expect(await run(tools, "propose_document", { path: "docs/ROADMAP.md", why: "done" })).toMatch(/names a receipt[\s\S]*track/);
        const bad = fakeClient(() => ({ ok: false, status: 409, error: "roadmap_invalid", data: { errors: ["R5: 2 nodes are `next`"] } }));
        const t2 = await toolsFor(bad.client, "project");
        await writeWorkingCopy(t2.taskPath, "docs/ROADMAP.md", "# Roadmap\n", "a".repeat(40));
        expect(await run(t2.tools, "propose_document", { path: "docs/ROADMAP.md", why: "x" })).toMatch(/R5: 2 nodes/);
    });
});

describe("notes and quick actions on the heartbeat", () => {
    it("delivers due notes as one message from Orkest, acks them, and each prompt as the person's", async () => {
        const { client, seen } = fakeClient((name) => name === "read_notes"
            ? { ok: true, status: 200, body: {
                notes: [{ runId: CHILD, state: "ended:proposed", child: { mode: "Afk", workLabel: "GHO-1", receiptId: "5e5e5e5e-0000-4000-8000-000000000005" } }],
                prompts: [{ id: "p1", text: "Reconcile the roadmap." }] } }
            : { ok: true, status: 200, body: { acked: true } });
        const sent: { text: string; id: string; from: string }[] = [];
        const out = await deliverProjectSessionNotes(client, CALL, { send: async (text, id, from) => { sent.push({ text, id, from }); return true } });
        expect(out).toEqual({ notes: 1, prompts: 1 });
        expect(sent[0]!.from).toBe("orkest");
        expect(sent[0]!.text).toMatch(/GHO-1 finished with a proposed change \(receipt 5e5e5e5e/);
        expect(sent[1]).toMatchObject({ from: "person", text: "Reconcile the roadmap." });
        expect(seen.filter((s) => s.name === "ack_notes")).toEqual([{ name: "ack_notes", args: { runId: CHILD, state: "ended:proposed" } }]);
        // The same notes again are the same message (a retried send is not a second one).
        const again: string[] = [];
        await deliverProjectSessionNotes(client, CALL, { send: async (_t, id) => { again.push(id); return true } });
        expect(again[0]).toBe(sent[0]!.id);
    });

    it("a send that fails acks nothing, so the note stays due", async () => {
        const { client, seen } = fakeClient((name) => name === "read_notes"
            ? { ok: true, status: 200, body: { notes: [{ runId: CHILD, state: "blocked:blocked_human" }], prompts: [] } }
            : { ok: true, status: 200, body: {} });
        expect(await deliverProjectSessionNotes(client, CALL, { send: async () => false })).toEqual({ notes: 0, prompts: 0 });
        expect(seen.map((s) => s.name)).toEqual(["read_notes"]);
        expect(noteLine({ runId: CHILD, state: "waiting_approval" })).toMatch(/cannot approve it/);
    });
});
