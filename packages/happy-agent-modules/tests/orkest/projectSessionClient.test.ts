import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { OrkestSessionClient } from "../../sources/orkest/impl/OrkestSessionClient.js";

// GHO-196.1.2 — the Happy adapter's client for the dashboard's session tools API and proposal route (GHO-195).

interface Seen {
    method: string;
    url: string;
    token: string | undefined;
    body: Record<string, unknown>;
}

const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** A fake dashboard: answers each request with `reply(seen)`. */
async function dashboard(reply: (seen: Seen) => { status: number; json?: unknown }) {
    const seen: Seen[] = [];
    const server = createServer(async (req, res) => {
        const s: Seen = {
            method: req.method ?? "",
            url: req.url ?? "",
            token: req.headers["x-orkest-worker-token"] as string | undefined,
            body: await body(req),
        };
        seen.push(s);
        const answer = reply(s);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, seen };
}

const CALL = {
    session: "0b9c5a52-6f1e-4d0f-9a1b-8b3c2d1e0f11",
    fence: 7,
    projectId: "4c2b1a0e-1111-4222-8333-944455556666",
};

describe("OrkestSessionClient", () => {
    it("posts a tool with the worker token and the session call", async () => {
        const fake = await dashboard(() => ({ status: 200, json: { docs: [] } }));
        const client = new OrkestSessionClient({ url: `${fake.url}/`, workerToken: "okw_test" });
        const answer = await client.tool("read_doc", CALL, { path: "docs/ROADMAP.md" });
        expect(answer).toEqual({ ok: true, status: 200, body: { docs: [] } });
        expect(fake.seen[0]).toMatchObject({
            method: "POST",
            url: "/internal/orkest/session/tools/read_doc",
            token: "okw_test",
            body: { ...CALL, path: "docs/ROADMAP.md" },
        });
    });

    it("keeps the session call fields over a tool argument of the same name", async () => {
        const fake = await dashboard(() => ({ status: 200, json: {} }));
        const client = new OrkestSessionClient({ url: fake.url, workerToken: "okw_test" });
        await client.tool("list_docs", CALL, { projectId: "other", fence: 1 });
        expect(fake.seen[0]?.body).toEqual(CALL);
    });

    it("refuses an unknown tool name before any request", async () => {
        const fake = await dashboard(() => ({ status: 200, json: {} }));
        const client = new OrkestSessionClient({ url: fake.url, workerToken: "okw_test" });
        await expect(client.tool("../proposal", CALL, {})).rejects.toThrow(/unknown session tool/);
        expect(fake.seen).toHaveLength(0);
    });

    it("posts a proposal and reads proposed, held and the refusals", async () => {
        const answers = [
            { status: 200, json: { state: "proposed", changes: 2, room: "orkest.x", group: "g" } },
            { status: 202, json: { state: "held", request: "r1" } },
            {
                status: 409,
                json: { statusMessage: "stale_base", data: { rev: "b".repeat(40), text: "new" } },
            },
            { status: 413, json: { statusMessage: "ORKEST_SESSION_PROPOSAL_TOO_LARGE" } },
            {
                status: 404,
                json: { statusMessage: "out_of_scope", data: { error: "out_of_scope" } },
            },
        ];
        const fake = await dashboard(() => answers.shift() ?? { status: 500 });
        const client = new OrkestSessionClient({ url: fake.url, workerToken: "okw_test" });
        const input = {
            path: "docs/ROADMAP.md",
            baseRev: "a".repeat(40),
            text: "# Roadmap\n",
            why: "add a plan",
            turn: "t1",
            model: "claude-code/sonnet",
            agentSessionId: "s1",
        };
        expect(await client.propose(CALL, input)).toMatchObject({
            ok: true,
            status: 200,
            body: { state: "proposed" },
        });
        expect(fake.seen[0]).toMatchObject({
            url: "/internal/orkest/session/proposal",
            token: "okw_test",
            body: { ...CALL, ...input },
        });
        expect(await client.propose(CALL, input)).toMatchObject({ ok: true, status: 202 });
        expect(await client.propose(CALL, input)).toEqual({
            ok: false,
            status: 409,
            error: "stale_base",
            data: { rev: "b".repeat(40), text: "new" },
        });
        expect(await client.propose(CALL, input)).toMatchObject({
            ok: false,
            status: 413,
            error: "ORKEST_SESSION_PROPOSAL_TOO_LARGE",
        });
        expect(await client.propose(CALL, input)).toMatchObject({
            ok: false,
            status: 404,
            error: "out_of_scope",
        });
    });

    it("throws on a server error without the token in the message", async () => {
        const fake = await dashboard(() => ({
            status: 502,
            json: { statusMessage: "bad gateway" },
        }));
        const client = new OrkestSessionClient({ url: fake.url, workerToken: "okw_secret_value" });
        const error = await client.tool("list_docs", CALL, {}).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message)).toMatch(/502/);
        expect(String((error as Error).message)).not.toContain("okw_secret_value");
    });
});
