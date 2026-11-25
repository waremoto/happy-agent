import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type {
    OrkestProposalInput,
    OrkestSessionClient,
} from "../../sources/orkest/impl/OrkestSessionClient.js";
import { proposalTurn, type ProposalTurnStore } from "../../sources/orkest/impl/proposalTurn.js";
import { projectSessionTools } from "../../sources/orkest/impl/projectSessionTools.js";
import { writeWorkingCopy } from "../../sources/orkest/impl/projectSessionWorkspace.js";

// GHO-205.7.1 (Orkest design D-52, P4 "Show previous scrolls the chat") — the Orkest-Turn on a proposal's commit is
// the proposing tool call's Base id, the id the transcript shows that call under, so the chat can scroll to it.

const TURN_ID = /^[A-Za-z0-9._:-]{1,100}$/; // the dashboard's and the renderer's turn check

function memoryStore(): ProposalTurnStore {
    const values = new Map<string, unknown>();
    return {
        async getOrCreate<Value>(_ctx: Context, key: string, create: () => Value | Promise<Value>) {
            if (!values.has(key)) values.set(key, await create());
            return values.get(key) as Value;
        },
    };
}

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the proposal turn", () => {
    it("is the first proposing call's id, kept for the rest of the run", async () => {
        const store = memoryStore();
        expect(await proposalTurn(store, {} as Context, "tc9m2k4q1x0p7z3w5v8n6b1a")).toBe(
            "tc9m2k4q1x0p7z3w5v8n6b1a",
        );
        expect(await proposalTurn(store, {} as Context, "another-call")).toBe(
            "tc9m2k4q1x0p7z3w5v8n6b1a",
        );
    });
    it("falls back to a random turn id when no call id passes the turn check", async () => {
        const turn = await proposalTurn(memoryStore(), {} as Context, "bad id with spaces");
        expect(turn).toMatch(/^t-[0-9a-f]{24}$/);
        expect(turn).toMatch(TURN_ID);
    });
    it("propose_document hands its call id to the turn", async () => {
        const taskPath = await mkdtemp(join(tmpdir(), "happy-turn-"));
        dirs.push(taskPath);
        await writeWorkingCopy(
            taskPath,
            "docs/ROADMAP.md",
            "# Roadmap\n\nnew line\n",
            "a".repeat(40),
        );
        const sent: OrkestProposalInput[] = [];
        const seen: (string | undefined)[] = [];
        const client = {
            propose: async (_call: unknown, input: OrkestProposalInput) => {
                sent.push(input);
                return { ok: true, status: 200, body: { state: "proposed", changes: 1 } };
            },
        } as unknown as OrkestSessionClient;
        const tool = projectSessionTools({
            client,
            call: () => ({ session: "s1", fence: 1 }) as never,
            taskPath,
            taskId: "task-1",
            agentHome: join(taskPath, "no-home"),
            agentId: "agent-1",
            permissionMode: "workspace_write",
            model: () => undefined,
            turn: async (_ctx, callId) => {
                seen.push(callId);
                return callId ?? "none";
            },
        }).find((t) => t.name === "propose_document")!;
        await tool.execute({} as Context, { path: "docs/ROADMAP.md", why: "add a line" }, {
            id: "callabc123",
        } as never);
        expect(seen).toEqual(["callabc123"]);
        expect(sent[0]?.turn).toBe("callabc123");
    });
});
