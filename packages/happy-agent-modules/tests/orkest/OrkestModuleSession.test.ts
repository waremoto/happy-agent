import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, inject, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { derivedId } from "../../sources/orkest/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider, type ScriptedTurn } from "../support/ScriptedProvider.js";
import { textTurn, toolCallTurn } from "../support/fixtures.js";

// GHO-196.2 — the Happy owner module opens a project or doc session (backend happy, GHO-195) with a working copy,
// the session preamble and the session tools, and proposes through the dashboard's proposal route.

const TOKEN = "orkest-test-service-token-0123456789abcdef";
const WORKER_TOKEN = "okw_session-worker";
const RUN = "0195f3a0-0000-7000-8000-0000000001aa";
const INTENT = "0195f3a0-0000-7000-8000-0000000001ab";
const PROJECT = "4c2b1a0e-1111-4222-8333-944455556666";
const REV = "a".repeat(40);
const REV2 = "b".repeat(40);
const ROADMAP = "# Roadmap\n\nThe plans of SYN.\n\n## Next\n\n- one\n- two\n";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
        try {
            await cleanup();
        } catch (error) {
            errors.push(error);
        }
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (errors.length) throw new AggregateError(errors, "Orkest session fixture cleanup failed");
}, 180_000);

interface Call {
    path: string;
    body: Record<string, unknown>;
    workerToken: string | undefined;
}

async function listen(
    handler: (path: string, body: Record<string, unknown>, call: Call) => [number, unknown],
) {
    const calls: Call[] = [];
    const read = async (request: IncomingMessage) => {
        let text = "";
        for await (const chunk of request) text += chunk;
        return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    };
    const server: Server = createServer(async (request, response) => {
        const body = await read(request);
        const path = new URL(request.url ?? "/", "http://x").pathname;
        const token = request.headers["x-orkest-worker-token"];
        const call = { path, body, workerToken: typeof token === "string" ? token : undefined };
        calls.push(call);
        const [status, value] = handler(path, body, call);
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address.");
    return { url: `http://127.0.0.1:${address.port}`, calls };
}

/** Father: one project session (backend happy) waiting for its owner. */
async function fakeFather(scope: {
    kind: "project" | "doc";
    projectId: string;
    path: string | null;
}) {
    const run = {
        runId: RUN,
        state: "admitted",
        harness: "codex",
        permissionMode: "workspace_write",
        title: "SYN plan review",
        brief: "",
        workLabel: scope.path ?? scope.projectId,
        endRequestedAt: null as string | null,
        intentId: INTENT,
        ownerJobRef: null as string | null,
        fence: 0,
        scope,
        backend: "happy",
        startedBy: { provider: "ghostshell", id: "syn-person" },
    };
    let intent: "pending" | "acknowledged" = "pending";
    const father = await listen((path, body) => {
        if (path === "/internal/agency/attended/pending")
            return [200, intent === "pending" ? [run] : []];
        if (path === "/internal/agency/attended/active")
            return [
                200,
                intent === "acknowledged" && ["dispatched", "running"].includes(run.state)
                    ? [run]
                    : [],
            ];
        if (path === `/internal/agency/intents/${INTENT}/ack`) {
            intent = "acknowledged";
            run.ownerJobRef = String(body.ownerJobRef);
            run.state = "dispatched";
            return [200, { status: "Ok" }];
        }
        if (path === `/internal/agency/runs/${RUN}/claim`) {
            run.state = "running";
            run.fence += 1;
            return [200, { status: "Ok", fenceToken: run.fence }];
        }
        if (path === `/internal/agency/runs/${RUN}/candidate-messages`) return [200, []];
        if (path.startsWith(`/internal/agency/runs/${RUN}/`)) return [200, { status: "Ok" }];
        if (path.startsWith(`/internal/agency/attended/${RUN}/`)) return [200, { status: "Ok" }];
        if (path.startsWith("/internal/agency/dossiers/")) return [200, []];
        return [404, {}];
    });
    return { ...father, run };
}

/** The dashboard's session seam: the doc, and every proposal recorded. */
async function fakeDashboard(options: { repo?: boolean; staleOnce?: boolean } = {}) {
    const state = { text: ROADMAP, rev: REV, staleOnce: options.staleOnce ?? false };
    const proposals: Record<string, unknown>[] = [];
    const dashboard = await listen((path, body, call) => {
        if (call.workerToken !== WORKER_TOKEN)
            return [401, { statusMessage: "ORKEST_SESSION_WORKER_TOKEN_REQUIRED" }];
        if (body.session !== RUN || body.projectId !== PROJECT || body.fence !== 1)
            return [404, { statusMessage: "out_of_scope", data: { error: "out_of_scope" } }];
        if (options.repo === false && path.startsWith("/internal/orkest/session/tools/"))
            return [404, { statusMessage: "ORKEST_GIT_NO_REPO" }];
        if (path === "/internal/orkest/session/tools/list_docs")
            return [
                200,
                {
                    project: PROJECT,
                    docs: [{ path: "docs/ROADMAP.md", rev: state.rev, tracker: false }],
                },
            ];
        if (path === "/internal/orkest/session/tools/read_doc") {
            if (body.path !== "docs/ROADMAP.md")
                return [404, { statusMessage: "doc_not_found", data: { error: "doc_not_found" } }];
            return [200, { project: PROJECT, path: body.path, rev: state.rev, text: state.text }];
        }
        if (path === "/internal/orkest/session/proposal") {
            proposals.push(body);
            if (body.baseRev === null)
                return [202, { state: "held", path: body.path, request: "req-1" }];
            if (state.staleOnce) {
                state.staleOnce = false;
                state.text = `${ROADMAP}\n## Later\n\n- moved by a person\n`;
                state.rev = REV2;
            }
            if (body.baseRev !== state.rev)
                return [
                    409,
                    {
                        statusMessage: "stale_base",
                        data: { error: "stale_base", rev: state.rev, text: state.text },
                    },
                ];
            return [
                200,
                {
                    state: "proposed",
                    path: body.path,
                    room: "orkest.r1",
                    group: "g1",
                    changes: 2,
                    large: false,
                },
            ];
        }
        return [404, { statusMessage: "ORKEST_SESSION_UNKNOWN_TOOL" }];
    });
    return { ...dashboard, proposals, state };
}

const dbCtx = (runtime: HappyAgentRuntime) => withAgentDatabase(runtime.ctx, runtime.database);

async function happy(fatherUrl: string, dashboardUrl: string, script: ScriptedTurn[] = []) {
    const home = await mkdtemp(join(inject("orkestFixtureRoot"), "session-"));
    const tokenFile = join(home, "orkest.token");
    await writeFile(tokenFile, TOKEN);
    const workerTokenFile = join(home, "orkest-worker.token");
    await writeFile(workerTokenFile, WORKER_TOKEN);
    const environment = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORKEST_AGENCY_URL: fatherUrl,
        ORKEST_AGENCY_TOKEN_FILE: tokenFile,
        ORKEST_WORKER_TOKEN_FILE: workerTokenFile,
        ORKEST_WORKER_ID: "happy:test",
        ORKEST_SESSION_URL: dashboardUrl,
    };
    vi.stubEnv("HOME", home);
    const happyHome = join(home, ".happy");
    const configPath = (await ConfigModule.load(happyHome, { environment })).configuration.paths
        .globalConfigPath;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "[features]\nattended_only = true\n");
    const provider = new ScriptedProvider(script);
    const providers = new AgentProviders();
    providers.add("codex", provider, "codex");
    const runtime = await startHappyAgentRuntime({
        happyHome,
        environment,
        inference: {
            providers,
            models: [
                {
                    id: "codex-cli/gpt-6.1-sol",
                    providerId: "codex",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
    });
    cleanups.push(async () => await runtime.close());
    cleanups.push(async () => await runtime.modules.orkest.close());
    return { runtime, provider };
}

const SCOPE = { kind: "project" as const, projectId: PROJECT, path: null };

async function openTask(runtime: HappyAgentRuntime, father: { run: { state: string } }) {
    await expect.poll(() => father.run.state, { timeout: 20_000 }).toBe("running");
    const task = await runtime.modules.tasks.get(dbCtx(runtime), derivedId("t", RUN));
    expect(task).toBeDefined();
    return task!;
}

async function say(runtime: HappyAgentRuntime, text: string, id: string) {
    await runtime.system.send(
        dbCtx(runtime),
        derivedId("a", RUN),
        { role: "user", content: [{ type: "text", text }] },
        { id: derivedId("a", `${RUN}:${id}`), metadata: USER_MESSAGE_ORIGIN_METADATA },
    );
}

const requests = (provider: ScriptedProvider) => provider.sessions.flatMap((s) => s.requests);

describe("Orkest project session on Happy (GHO-196)", () => {
    it("opens a project session with no draft, a working copy of the roadmap and the preamble", async () => {
        const father = await fakeFather(SCOPE);
        const dashboard = await fakeDashboard();
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            textTurn("Read it."),
        ]);
        const task = await openTask(runtime, father);

        const config = await runtime.system.config(dbCtx(runtime), derivedId("a", RUN));
        expect(config?.metadata?.["draft"]).toBeUndefined();
        await expect
            .poll(
                async () => readFile(join(task.path, "doc", "ROADMAP.md"), "utf8").catch(() => ""),
                {
                    timeout: 10_000,
                },
            )
            .toBe(ROADMAP);
        expect(
            JSON.parse(await readFile(join(task.path, "doc", ".orkest-bases.json"), "utf8")),
        ).toEqual({
            "docs/ROADMAP.md": REV,
        });
        expect(dashboard.calls.every((c) => c.workerToken === WORKER_TOKEN)).toBe(true);

        await say(runtime, "What is next?", "m1");
        await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
        const instructions = provider.sessions[0]!.options.instructions;
        expect(instructions).toContain("Orkest project session");
        expect(instructions).toContain(PROJECT);
        expect(instructions).toContain("doc/ROADMAP.md");
        expect(instructions).toContain("propose_document");
        expect(instructions).toContain("Next");
    }, 90_000);

    it("opens a project with no docs with the no-docs preamble", async () => {
        const father = await fakeFather(SCOPE);
        const dashboard = await fakeDashboard({ repo: false });
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            textTurn("No docs."),
        ]);
        const task = await openTask(runtime, father);
        await say(runtime, "What needs me?", "m1");
        await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
        const instructions = provider.sessions[0]!.options.instructions;
        expect(instructions).toMatch(/no docs yet/);
        expect(instructions).not.toContain("doc/ROADMAP.md");
        await expect(readFile(join(task.path, "doc", "ROADMAP.md"), "utf8")).rejects.toThrow();
    }, 90_000);
});
