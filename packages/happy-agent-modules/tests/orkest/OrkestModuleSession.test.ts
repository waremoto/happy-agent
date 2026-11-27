import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
async function fakeFather(
    scope: {
        kind: "project" | "doc" | "ticket";
        projectId: string;
        path: string | null;
        repoPath?: string | null;
    },
    extra: Record<string, unknown> = {},
) {
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
        ...extra,
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
        // The composer keeps the session's mode, but no drafted text: the person's first message is theirs.
        expect(config?.metadata?.["draft"]).toMatchObject({
            text: "",
            permissionMode: "workspace_write",
        });
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

describe("Orkest project session tools on Happy (GHO-196.2.2)", () => {
    const copy = (taskPath: string, name = "ROADMAP.md") => join(taskPath, "doc", name);
    const toolTurn = (
        callId: string,
        name: string,
        args: unknown,
        before?: () => Promise<void>,
    ): ScriptedTurn =>
        before === undefined
            ? toolCallTurn(callId, name, JSON.stringify(args))
            : () =>
                  (async function* () {
                      await before();
                      yield* toolCallTurn(callId, name, JSON.stringify(args));
                  })();
    const toolResults = (provider: ScriptedProvider) =>
        JSON.stringify(requests(provider).map((r) => r.context.messages));

    it("proposes the edited working copy whole, with its base, turn, model and session id", async () => {
        const father = await fakeFather(SCOPE);
        const dashboard = await fakeDashboard();
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            toolTurn("c1", "propose_document", {
                path: "docs/ROADMAP.md",
                why: "add a third step",
            }),
            textTurn("Proposed."),
        ]);
        const task = await openTask(runtime, father);
        await expect
            .poll(async () => readFile(copy(task.path), "utf8").catch(() => ""), {
                timeout: 10_000,
            })
            .toBe(ROADMAP);
        await writeFile(copy(task.path), `${ROADMAP}- three\n`);
        await say(runtime, "Add a third step.", "m1");
        await expect.poll(() => dashboard.proposals.length, { timeout: 20_000 }).toBe(1);
        const sent = dashboard.proposals[0]!;
        expect(sent).toMatchObject({
            session: RUN,
            fence: 1,
            projectId: PROJECT,
            path: "docs/ROADMAP.md",
            baseRev: REV,
            text: `${ROADMAP}- three\n`,
            why: "add a third step",
            model: "codex-cli/gpt-6.1-sol",
            agentSessionId: derivedId("t", RUN),
        });
        expect(String(sent.turn)).toMatch(/^[A-Za-z0-9._:-]{1,100}$/);
        await expect
            .poll(() => toolResults(provider), { timeout: 20_000 })
            .toContain("Proposed 2 change");
    }, 90_000);

    it("refreshes the working copy on a stale base and lands the re-applied change", async () => {
        const father = await fakeFather(SCOPE);
        const dashboard = await fakeDashboard({ staleOnce: true });
        let taskPath = "";
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            toolTurn("c1", "propose_document", { path: "docs/ROADMAP.md", why: "add three" }),
            toolTurn(
                "c2",
                "propose_document",
                { path: "docs/ROADMAP.md", why: "add three again" },
                async () => {
                    const current = await readFile(copy(taskPath), "utf8");
                    await writeFile(copy(taskPath), `${current}- three\n`);
                },
            ),
            textTurn("Proposed after the doc moved."),
        ]);
        const task = await openTask(runtime, father);
        taskPath = task.path;
        await expect
            .poll(async () => readFile(copy(task.path), "utf8").catch(() => ""), {
                timeout: 10_000,
            })
            .toBe(ROADMAP);
        await writeFile(copy(task.path), `${ROADMAP}- three\n`);
        await say(runtime, "Add a third step.", "m1");
        await expect.poll(() => dashboard.proposals.length, { timeout: 30_000 }).toBe(2);
        expect(dashboard.proposals[0]).toMatchObject({ baseRev: REV });
        expect(dashboard.proposals[1]).toMatchObject({ baseRev: REV2 });
        expect(String(dashboard.proposals[1]!.text)).toContain("moved by a person");
        expect(String(dashboard.proposals[1]!.text).endsWith("- three\n")).toBe(true);
        expect(await readFile(join(task.path, "doc", ".stale", "ROADMAP.md"), "utf8")).toBe(
            `${ROADMAP}- three\n`,
        );
        expect(toolResults(provider)).toMatch(/moved/);
    }, 90_000);

    it("proposes a new doc with no base, which waits for the person's approval", async () => {
        const father = await fakeFather(SCOPE);
        const dashboard = await fakeDashboard();
        let taskPath = "";
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            toolTurn(
                "c1",
                "propose_document",
                { path: "docs/plan-b.md", why: "start plan B" },
                async () => {
                    await writeFile(copy(taskPath, "plan-b.md"), "# Plan B\n");
                },
            ),
            textTurn("Asked."),
        ]);
        taskPath = (await openTask(runtime, father)).path;
        await say(runtime, "Start a plan B doc.", "m1");
        await expect.poll(() => dashboard.proposals.length, { timeout: 20_000 }).toBe(1);
        expect(dashboard.proposals[0]).toMatchObject({
            path: "docs/plan-b.md",
            baseRev: null,
            text: "# Plan B\n",
        });
        await expect.poll(() => toolResults(provider), { timeout: 20_000 }).toMatch(/approv/);
    }, 90_000);

    it("reads a doc into its working copy through read_doc", async () => {
        const father = await fakeFather({
            kind: "doc",
            projectId: PROJECT,
            path: "docs/ROADMAP.md",
        });
        const dashboard = await fakeDashboard();
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            toolTurn("c1", "read_doc", { path: "docs/ROADMAP.md" }),
            toolTurn("c2", "list_tickets", {}),
            textTurn("Read."),
        ]);
        const task = await openTask(runtime, father);
        await say(runtime, "Read the roadmap.", "m1");
        await expect
            .poll(() => toolResults(provider), { timeout: 20_000 })
            .toContain("doc/ROADMAP.md");
        expect(
            dashboard.calls.filter((c) => c.path.endsWith("/tools/read_doc")).length,
        ).toBeGreaterThanOrEqual(2);
        await expect
            .poll(() => dashboard.calls.some((c) => c.path.endsWith("/tools/list_tickets")), {
                timeout: 20_000,
            })
            .toBe(true);
        expect(await readFile(copy(task.path), "utf8")).toBe(ROADMAP);
    }, 90_000);

    // GHO-204 (ORKEST-CHAT-BY-PROJECT, D-33)
    it("opens at the project's repository, tells the agent, and refuses a write there", async () => {
        const repo = await mkdtemp(join(inject("orkestFixtureRoot"), "repo-"));
        await writeFile(join(repo, "README.md"), "# repo\n");
        const father = await fakeFather({ ...SCOPE, repoPath: repo });
        const dashboard = await fakeDashboard();
        const patch = (path: string) =>
            `*** Begin Patch\n*** Add File: ${path}\n+hello\n*** End Patch`;
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            toolTurn("c1", "apply_patch", { patch: patch(join(repo, "new.txt")) }),
            textTurn("Refused."),
        ]);
        const task = await openTask(runtime, father);

        const config = await runtime.system.config(dbCtx(runtime), derivedId("a", RUN));
        expect(config?.environment?.workingDirectory).toBe(repo);
        expect(config?.metadata?.["orkestProjectId"]).toBe(PROJECT);
        // The task keeps its own folder for the working copies.
        await expect
            .poll(async () => readFile(copy(task.path), "utf8").catch(() => ""), {
                timeout: 10_000,
            })
            .toBe(ROADMAP);

        await say(runtime, "Add a file.", "m1");
        await expect.poll(() => toolResults(provider), { timeout: 20_000 }).toMatch(/repository/);
        await expect(stat(join(repo, "new.txt"))).rejects.toThrow();
        const instructions = provider.sessions[0]!.options.instructions;
        expect(instructions).toContain(
            `You start in the project's repository at ${repo}. Read it freely.`,
        );
        expect(instructions).toContain(`${task.path}/doc`);
    }, 90_000);

    it("opens an empty project folder when the project has no repository on this host", async () => {
        const father = await fakeFather({
            ...SCOPE,
            repoPath: join(tmpdirFor(), "not-on-this-host"),
        });
        const dashboard = await fakeDashboard();
        const { runtime, provider } = await happy(father.url, dashboard.url, [
            textTurn("Read it."),
        ]);
        const task = await openTask(runtime, father);

        const config = await runtime.system.config(dbCtx(runtime), derivedId("a", RUN));
        expect(config?.environment?.workingDirectory).toBe(join(task.path, "project"));
        expect((await stat(join(task.path, "project"))).isDirectory()).toBe(true);
        await say(runtime, "Where are we?", "m1");
        await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
        expect(provider.sessions[0]!.options.instructions).toContain(`${task.path}/project`);
    }, 90_000);

    // GHO-207.2.1 — the person is told when the project's repository is not on this host.
    it("tells the agent to say so first when the named repository is not on this host", async () => {
        const missing = join(tmpdirFor(), "not-on-this-host-either");
        const father = await fakeFather({ ...SCOPE, repoPath: missing });
        const dashboard = await fakeDashboard();
        const { runtime, provider } = await happy(father.url, dashboard.url, [textTurn("Noted.")]);
        await openTask(runtime, father);
        await say(runtime, "Where are we?", "m1");
        await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
        const instructions = provider.sessions[0]!.options.instructions;
        expect(instructions).toContain(
            `Note: this project's repository (${missing}) is not on this host, so this chat is not running in the project folder.`,
        );
        expect(instructions).toContain("Begin your first reply with exactly that sentence");
    }, 90_000);

    // GHO-207.2.3 — a project's committed harness mode answers the owner's in-path native questions.
    it("turns on the project's committed harness mode for its owner, and only for in-path local actions", async () => {
        const repo = await committedRepo({ ".orkest/harness-mode.json": '{"schema":1,"enabled":true,"owners":["ghostshell:syn-person"]}\n' });
        const father = await fakeFather({ ...SCOPE, repoPath: repo });
        const dashboard = await fakeDashboard();
        const { runtime, provider } = await happy(father.url, dashboard.url, [textTurn("Ready.")]);
        await openTask(runtime, father);
        await say(runtime, "Hello.", "m1");
        await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
        const instructions = provider.sessions[0]!.options.instructions;
        expect(instructions).toContain("with the project's harness mode on");
        expect(instructions).not.toContain("Never write, delete or run commands that change files there");

        const ctx = dbCtx(runtime);
        const agent = derivedId("a", RUN);
        const ask = (action: string, input: unknown, signal: AbortSignal) =>
            runtime.modules.userInput.askForNativeToolPermission(
                ctx,
                agent,
                { provider: "claude", providerTitle: "Claude Code", action, input, inputDigest: "sha256:" + "0".repeat(64) },
                signal,
            );
        expect(await ask(`Write: ${join(repo, "notes.txt")}`, { file_path: join(repo, "notes.txt") }, new AbortController().signal)).toBe(true);
        expect(await ask("Bash: git add notes.txt && git commit -m n", { command: "git add notes.txt && git commit -m n" }, new AbortController().signal)).toBe(true);
        expect(await runtime.modules.userInput.list(ctx, agent, {})).toEqual([]);
        // A push still reaches the person.
        const stop = new AbortController();
        const push = ask("Bash: git push", { command: "git push" }, stop.signal);
        await expect
            .poll(async () => (await runtime.modules.userInput.list(ctx, agent, { status: "pending" })).length, { timeout: 10_000 })
            .toBe(1);
        stop.abort();
        expect(await push).toBe(false);
    }, 90_000);

    it("keeps harness mode off for an uncommitted file, another owner, or a read-only session", async () => {
        const cases = [
            { files: {}, loose: '{"schema":1,"enabled":true}', extra: {} },
            { files: { ".orkest/harness-mode.json": '{"schema":1,"enabled":true,"owners":["ghostshell:someone-else"]}' }, extra: {} },
            { files: { ".orkest/harness-mode.json": '{"schema":1,"enabled":true}' }, extra: { permissionMode: "read_only" } },
        ];
        for (const c of cases) {
            const repo = await committedRepo(c.files);
            if (c.loose) {
                await mkdir(join(repo, ".orkest"), { recursive: true });
                await writeFile(join(repo, ".orkest/harness-mode.json"), c.loose);
            }
            const father = await fakeFather({ ...SCOPE, repoPath: repo }, c.extra);
            const dashboard = await fakeDashboard();
            const { runtime, provider } = await happy(father.url, dashboard.url, [textTurn("Ready.")]);
            await openTask(runtime, father);
            await say(runtime, "Hello.", "m1");
            await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
            expect(provider.sessions[0]!.options.instructions).not.toContain("harness mode on");
            const stop = new AbortController();
            const write = runtime.modules.userInput.askForNativeToolPermission(
                dbCtx(runtime),
                derivedId("a", RUN),
                { provider: "claude", providerTitle: "Claude Code", action: "Write: notes.txt", input: { file_path: join(repo, "notes.txt") }, inputDigest: "sha256:" + "0".repeat(64) },
                stop.signal,
            );
            await expect
                .poll(async () => (await runtime.modules.userInput.list(dbCtx(runtime), derivedId("a", RUN), { status: "pending" })).length, { timeout: 10_000 })
                .toBe(1);
            stop.abort();
            expect(await write).toBe(false);
        }
    }, 240_000);

    it("starts a ticket session of a project in its repository and tells its agent the work item", async () => {
        const repo = await mkdtemp(join(inject("orkestFixtureRoot"), "repo-"));
        const father = await fakeFather(
            { kind: "ticket", projectId: PROJECT, path: null, repoPath: repo },
            {
                projectId: PROJECT,
                workLabel: "SYN-7",
                title: "SYN-7: Tighten login",
                brief: "The brief.",
            },
        );
        const { runtime, provider } = await happy(father.url, "http://127.0.0.1:9", [textTurn("On it.")]);
        await openTask(runtime, father);
        const config = await runtime.system.config(dbCtx(runtime), derivedId("a", RUN));
        expect(config?.environment?.workingDirectory).toBe(repo);
        expect(config?.metadata?.["orkestProjectId"]).toBe(PROJECT);
        // GHO-207.3.1: the composer is the person's; the work item reaches the agent as instructions.
        expect((config?.metadata?.["draft"] as { text?: string } | undefined)?.text ?? "").toBe("");
        await say(runtime, "Go.", "m1");
        await expect.poll(() => requests(provider).length, { timeout: 20_000 }).toBeGreaterThan(0);
        const instructions = provider.sessions[0]!.options.instructions;
        expect(instructions).toContain("Orkest work item SYN-7: Tighten login");
        expect(instructions).toContain("The brief.");
    }, 90_000);

    it("starts an old ticket row, with no project, in its own task folder as before", async () => {
        const father = await fakeFather(SCOPE, {
            scope: undefined,
            workLabel: "SYN-8",
            title: "SYN-8: Old row",
            brief: "Old.",
        });
        const { runtime } = await happy(father.url, "http://127.0.0.1:9");
        const task = await openTask(runtime, father);
        const config = await runtime.system.config(dbCtx(runtime), derivedId("a", RUN));
        expect(config?.environment?.workingDirectory).toBe(task.path);
        expect(config?.metadata?.["orkestProjectId"]).toBeUndefined();
    }, 90_000);
});

/** A git repository in the fixture root with these files committed. */
async function committedRepo(files: Record<string, string>): Promise<string> {
    const { execFileSync } = await import("node:child_process");
    const repo = await mkdtemp(join(inject("orkestFixtureRoot"), "repo-"));
    await writeFile(join(repo, "README.md"), "# repo\n");
    for (const [name, text] of Object.entries(files)) {
        await mkdir(dirname(join(repo, name)), { recursive: true });
        await writeFile(join(repo, name), text);
    }
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, "-c", "user.name=syn", "-c", "user.email=syn@example.invalid", ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "synthetic");
    return repo;
}

function tmpdirFor(): string {
    return inject("orkestFixtureRoot");
}
