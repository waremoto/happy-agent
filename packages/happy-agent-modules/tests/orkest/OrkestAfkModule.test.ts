import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    rmdir,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import type { SessionStream } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, inject, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import {
    OrkestAfkModule,
    afkDerivedId,
    afkFolderName,
    afkReadStaysInside,
    derivedId,
} from "../../sources/orkest/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { textTurn, toolCallTurn } from "../support/fixtures.js";
import { ScriptedProvider, type ScriptedTurn } from "../support/ScriptedProvider.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const SERVICE_TOKEN = "orkest-afk-service-token-0123456789abcdef";
const WORKER_TOKEN = "okw_afk-worker-secret";
const RUN = "0195f3a0-0000-7000-8000-000000000101";
const INTENT = "0195f3a0-0000-7000-8000-0000000001aa";
const MODEL = "anthropic/afk-scripted";
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
    if (errors.length) throw new AggregateError(errors, "Orkest AFK fixture cleanup failed");
}, 180_000);

interface Call {
    method: string;
    path: string;
    body: unknown;
    serviceToken: string | undefined;
    workerToken: string | undefined;
}

interface ApprovalRow {
    approvalId: string;
    runId: string;
    key: string;
    tool: string;
    state: "pending" | "approved" | "denied" | "cancelled";
    answeredBy: string | null;
    note: string | null;
    summary: string;
    reason: string;
    inputSha256: string;
    inputPreview: string;
}

/**
 * Father's AFK lane, in memory: one unattended run queued for a worker. It answers only the right
 * service token together with the right worker token, and records every call.
 */
async function fakeAfkAgency(
    options: {
        autoAnswer?: "approved" | "denied";
        projectId?: string;
        additionalRuns?: Array<{ runId: string; intentId: string; projectId?: string }>;
    } = {},
) {
    const calls: Call[] = [];
    const approvals = new Map<string, ApprovalRow>();
    const run = {
        runId: RUN,
        tenantId: "tenant-1",
        state: "admitted",
        stateReason: null as string | null,
        title: "WAR-9: Say hello",
        brief: "Create hello.txt containing the word hello.",
        workLabel: "WAR-9",
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        workProvider: "orkest",
        workExternalId: "WAR-9",
        createdBy: "human-1",
        createdAt: "2026-11-22T10:00:00Z",
        stopRequestedAt: null as string | null,
        intent: "pending" as "pending" | "acknowledged",
        intentId: INTENT as string | null,
        ownerJobRef: null as string | null,
        leaseHolder: null as string | null,
        fence: 0,
    };
    const runs = [
        run,
        ...(options.additionalRuns ?? []).map((additional) => ({
            ...run,
            ...additional,
            title: `${additional.runId}: Additional test run`,
            brief: "Complete the additional test run.",
            workLabel: additional.runId,
            workExternalId: additional.runId,
            state: "admitted",
            stateReason: null,
            stopRequestedAt: null,
            intent: "pending" as const,
            ownerJobRef: null,
            leaseHolder: null,
            fence: 0,
        })),
    ];
    const read = async (request: IncomingMessage) => {
        let text = "";
        for await (const chunk of request) text += chunk;
        return text.length === 0 ? null : JSON.parse(text);
    };
    const server: Server = createServer(async (request, response) => {
        const body = await read(request);
        const url = new URL(request.url ?? "/", "http://agency");
        const header = (name: string) => {
            const value = request.headers[name];
            return typeof value === "string" ? value : undefined;
        };
        calls.push({
            method: request.method ?? "",
            path: url.pathname,
            body,
            serviceToken: header("x-ghost-service-token"),
            workerToken: header("x-orkest-worker-token"),
        });
        const send = (status: number, value: unknown) => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(value));
        };
        // GHO-189: the worker holds only its own token; a call that carries Father's service token is refused.
        if (header("x-ghost-service-token") !== undefined) return send(401, {});
        if (header("x-orkest-worker-token") !== WORKER_TOKEN) return send(401, {});
        const path = url.pathname;
        const pathRun = /^\/internal\/agency\/(?:runs|afk)\/([^/]+)/.exec(path)?.[1] ?? undefined;
        const targetRun = runs.find((candidate) => candidate.runId === pathRun) ?? run;
        const fenced = () => (body as { fence?: number } | null)?.fence === targetRun.fence;
        const live = () => targetRun.state === "running";
        if (path === "/internal/agency/afk/pending") {
            return send(
                200,
                runs.filter((candidate) => candidate.intent === "pending"),
            );
        }
        if (path === "/internal/agency/afk/active") {
            return send(
                200,
                runs.filter(
                    (candidate) =>
                        candidate.intent === "acknowledged" &&
                        ["dispatched", "running"].includes(candidate.state),
                ),
            );
        }
        const ack = /^\/internal\/agency\/intents\/([^/]+)\/ack$/.exec(path);
        const ackRun = ack && runs.find((candidate) => candidate.intentId === ack[1]);
        if (ackRun) {
            ackRun.intent = "acknowledged";
            ackRun.ownerJobRef = (body as { ownerJobRef: string }).ownerJobRef;
            ackRun.state = "dispatched";
            return send(200, { status: "Ok" });
        }
        const runAction =
            /^\/internal\/agency\/runs\/([^/]+)\/(claim|heartbeat|publish|artifacts|complete)$/.exec(
                path,
            );
        if (runAction) {
            if (runAction[2] === "claim") {
                if (!["dispatched", "running"].includes(targetRun.state)) return send(409, {});
                targetRun.state = "running";
                targetRun.fence += 1;
                targetRun.leaseHolder = (body as { workerId: string }).workerId;
                return send(200, {
                    status: "Ok",
                    runId: targetRun.runId,
                    attempt: targetRun.fence,
                    fenceToken: targetRun.fence,
                    expiresAt: "2026-11-22T10:02:00Z",
                });
            }
            if (runAction[2] === "heartbeat" || runAction[2] === "publish") {
                return fenced() && live() ? send(200, { status: "Ok" }) : send(409, {});
            }
            if (runAction[2] === "artifacts") {
                return fenced() && live() ? send(201, { artifactId: "art-1" }) : send(409, {});
            }
            if (runAction[2] === "complete") {
                if (!fenced() || !live()) return send(409, {});
                const done = body as { proposed: boolean; outcome?: string };
                targetRun.state = done.proposed ? "proposed" : (done.outcome ?? "failed");
                return send(200, { status: "Ok" });
            }
        }
        const approvalRoute = /^\/internal\/agency\/afk\/([^/]+)\/approvals(?:\/(.+))?$/.exec(path);
        if (approvalRoute && request.method === "POST" && approvalRoute[2] === undefined) {
            if (!fenced() || !live()) return send(409, {});
            const ask = body as Omit<ApprovalRow, "approvalId" | "runId" | "state">;
            const approvalKey = `${targetRun.runId}:${ask.key}`;
            const existing = approvals.get(approvalKey);
            if (existing) return send(200, existing);
            const row: ApprovalRow = {
                approvalId: `approval-${approvals.size + 1}`,
                runId: targetRun.runId,
                key: ask.key,
                tool: ask.tool,
                state: options.autoAnswer ?? "pending",
                answeredBy: options.autoAnswer === undefined ? null : "human-1",
                note: null,
                summary: ask.summary,
                reason: ask.reason,
                inputSha256: ask.inputSha256,
                inputPreview: ask.inputPreview,
            };
            approvals.set(approvalKey, row);
            return send(200, row);
        }
        if (approvalRoute && request.method === "GET" && approvalRoute[2] !== undefined) {
            const key = decodeURIComponent(approvalRoute[2]);
            const row = approvals.get(`${targetRun.runId}:${key}`);
            return row ? send(200, row) : send(404, {});
        }
        return send(404, {});
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
    const of = (suffix: string) => calls.filter((call) => call.path.endsWith(suffix));
    return {
        url: `http://127.0.0.1:${address.port}`,
        calls,
        run,
        runs,
        approvals,
        of,
        progress: () =>
            of("/publish").map((call) => (call.body as { payload: { text: string } }).payload.text),
        receipts: () =>
            of("/artifacts").map(
                (call) =>
                    JSON.parse(
                        Buffer.from(
                            (call.body as { contentBase64: string }).contentBase64,
                            "base64",
                        ).toString("utf8"),
                    ) as Record<string, unknown>,
            ),
        completes: () => of("/complete").map((call) => call.body),
    };
}

interface Installation {
    home: string;
    environment: Record<string, string | undefined>;
}

/** A Happy home with the AFK lane configured; reused across a restart by passing it back in. */
async function afkInstallation(
    agencyUrl: string,
    options: { attendedOnly?: boolean; extra?: Record<string, string> } = {},
): Promise<Installation> {
    const home = await mkdtemp(join(inject("orkestFixtureRoot"), "afk-"));
    const workerTokenFile = join(home, "orkest-afk-worker.token");
    await writeFile(workerTokenFile, `${WORKER_TOKEN}\n`);
    const environment = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORKEST_AFK_URL: agencyUrl,
        ORKEST_AFK_WORKER_TOKEN_FILE: workerTokenFile,
        ORKEST_AFK_WORKER_ID: "happy-afk:test",
        ORKEST_AFK_MODEL: `scripted:${MODEL}`,
        ...options.extra,
    };
    if (options.attendedOnly ?? true) {
        const path = (await ConfigModule.load(join(home, ".happy"), { environment })).configuration
            .paths.globalConfigPath;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "[features]\nattended_only = true\n");
    }
    return { home, environment };
}

async function afkHappy(
    installation: Installation,
    provider: ScriptedProvider,
): Promise<HappyAgentRuntime & { closeForTest: () => Promise<void> }> {
    vi.stubEnv("HOME", installation.home);
    // The owner marks the process itself; unstubbing after the test takes the mark away again.
    vi.stubEnv("ORKEST_AFK_RUN", undefined);
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
    const runtime = await startHappyAgentRuntime({
        happyHome: join(installation.home, ".happy"),
        environment: installation.environment,
        inference: {
            providers,
            models: [
                {
                    id: MODEL,
                    providerId: "scripted",
                    name: "Scripted",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
    });
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await runtime.modules.orkestAfk.close();
        await runtime.close();
    };
    cleanups.push(close);
    return Object.assign(runtime, { closeForTest: close });
}

const dbCtx = (runtime: HappyAgentRuntime) => withAgentDatabase(runtime.ctx, runtime.database);

/** A turn that never finishes on its own: the run stays in flight until the runtime stops. */
const hangingTurn: ScriptedTurn = (ctx: Context): SessionStream =>
    (async function* () {
        await new Promise<void>((resolve) => {
            const lifetime = ctx.lifetime;
            if (lifetime === undefined) return;
            if (lifetime.aborted) resolve();
            lifetime.addEventListener("abort", () => resolve(), { once: true });
        });
    })();

/** The Write call a scripted model makes once the run's work directory is known. */
function writeHello(workDir: Promise<string>, callId = "callwrite1"): ScriptedTurn {
    return () =>
        (async function* () {
            const path = join(await workDir, "hello.txt");
            yield* toolCallTurn(
                callId,
                "Write",
                JSON.stringify({ file_path: path, content: "hello" }),
            );
        })();
}

/** Resolves to the run's work directory once its task exists. */
function workDirOf(runtime: Promise<HappyAgentRuntime>): Promise<string> {
    return (async () => {
        const happy = await runtime;
        const taskId = afkDerivedId("t", RUN);
        for (let attempt = 0; attempt < 600; attempt += 1) {
            const task = await happy.modules.tasks.get(dbCtx(happy), taskId);
            if (task !== undefined) return task.path;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return "";
    })().catch(() => "");
}

async function userTexts(runtime: HappyAgentRuntime): Promise<string[]> {
    const records = await runtime.modules.history.messages(
        dbCtx(runtime),
        afkDerivedId("a", RUN),
        {},
    );
    return records
        .filter((record) => record.message.role === "user")
        .map((record) => JSON.stringify(record.message.blocks));
}

describe("Orkest AFK owner (GHO-189.3.1)", () => {
    it("drains a queued run into a derived task, works it, publishes a receipt and completes it as proposed", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "approved" });
        const installation = await afkInstallation(agency.url);
        let started!: (runtime: HappyAgentRuntime) => void;
        const runtimeReady = new Promise<HappyAgentRuntime>((resolve) => (started = resolve));
        const provider = new ScriptedProvider([
            writeHello(workDirOf(runtimeReady)),
            textTurn("Created hello.txt."),
        ]);
        const runtime = await afkHappy(installation, provider);
        started(runtime);
        const taskId = afkDerivedId("t", RUN);
        const agentId = afkDerivedId("a", RUN);

        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");

        // Acknowledged as the derived task, then claimed by this worker with a 120 s lease.
        expect(agency.of("/ack")[0]?.body).toEqual({ ownerJobRef: taskId });
        expect(agency.of("/claim")[0]?.body).toEqual({
            workerId: "happy-afk:test",
            leaseSeconds: 120,
        });
        const task = await runtime.modules.tasks.get(dbCtx(runtime), taskId);
        expect(task).toMatchObject({
            name: "WAR-9: Say hello",
            agentId,
            folderName: afkFolderName(RUN),
        });
        // Distinct from the attended owner's identities for the same run.
        expect(taskId).not.toBe(derivedId("t", RUN));

        // The brief is the first and only user message.
        const texts = await userTexts(runtime);
        expect(texts).toHaveLength(1);
        expect(texts[0]).toContain("Create hello.txt containing the word hello.");
        expect(provider.sessions[0]?.requests.length).toBeGreaterThanOrEqual(1);

        // Progress lines were published under the run's fence, short and free of tool inputs.
        expect(agency.progress()[0]).toBe("Started");
        for (const call of agency.of("/publish")) {
            expect(call.body).toMatchObject({
                fence: 1,
                eventType: "afk.progress",
                toolId: null,
            });
            const text = (call.body as { payload: { text: string } }).payload.text;
            expect(text.length).toBeLessThanOrEqual(300);
            expect(text).not.toContain("hello.txt");
        }

        // The receipt is published before the run completes as proposed.
        const paths = agency.calls.map((call) => call.path);
        const receiptAt = paths.indexOf(`/internal/agency/runs/${RUN}/artifacts`);
        const completeAt = paths.indexOf(`/internal/agency/runs/${RUN}/complete`);
        expect(receiptAt).toBeGreaterThan(-1);
        expect(receiptAt).toBeLessThan(completeAt);
        expect(agency.of("/artifacts")[0]?.body).toMatchObject({
            fence: 1,
            kind: "afk.receipt",
            name: "receipt.json",
            mediaType: "application/json",
            inputs: [],
        });
        expect(agency.receipts()[0]).toMatchObject({
            runId: RUN,
            title: "WAR-9: Say hello",
            workLabel: "WAR-9",
            outcome: "proposed",
            summary: "Created hello.txt.",
        });
        expect(agency.completes()).toEqual([
            { fence: 1, proposed: true, consumed: 1, reason: "done" },
        ]);
        // Every call carried this worker's own token and never Father's service token.
        expect(agency.calls.length).toBeGreaterThan(5);
        for (const call of agency.calls) {
            expect(call.serviceToken).toBeUndefined();
            expect(call.workerToken).toBe(WORKER_TOKEN);
        }
    }, 90_000);

    it("marks the daemon's own environment as unattended, so the Orkest helper in its shells knows", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url);
        await afkHappy(installation, new ScriptedProvider([hangingTurn]));
        // Agent shells inherit this process environment; `orkest.py` reads the variable (Rule 24).
        await expect.poll(() => process.env.ORKEST_AFK_RUN, { timeout: 60_000 }).toBe("1");
    }, 90_000);

    it("reclaims its run after a restart with a higher fence, without re-sending the brief or opening a second task", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "approved" });
        const installation = await afkInstallation(agency.url);
        const first = await afkHappy(installation, new ScriptedProvider([hangingTurn]));
        await expect.poll(() => agency.progress()[0], { timeout: 30_000 }).toBe("Started");
        expect(agency.run.fence).toBe(1);
        await first.closeForTest();

        const callsBefore = agency.calls.length;
        const provider = new ScriptedProvider([textTurn("Picked up where I stopped. Done.")]);
        const second = await afkHappy(installation, provider);
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");

        // A new claim, so the previous process's fence stops counting.
        const claims = agency.of("/claim");
        expect(claims).toHaveLength(2);
        expect(agency.run.fence).toBe(2);
        expect(agency.calls.slice(callsBefore).some((c) => c.path.endsWith("/ack"))).toBe(false);
        // The brief once, then exactly one continuation.
        const texts = await userTexts(second);
        expect(texts).toHaveLength(2);
        expect(texts.filter((t) => t.includes("Create hello.txt containing"))).toHaveLength(1);
        expect(texts[1]).toContain("restarted");
        expect(texts[1]).toContain("did not run");
        // Still one task for the run.
        const tasks = (await second.modules.tasks.list(dbCtx(second))).filter(
            (task) => task.folderName === afkFolderName(RUN),
        );
        expect(tasks).toHaveLength(1);
        expect(agency.completes()).toEqual([
            { fence: 2, proposed: true, consumed: 1, reason: "done" },
        ]);
    }, 120_000);

    it("uses the configured repository directly without making a git worktree", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "approved" });
        const scratch = await mkdtemp(join(tmpdir(), "happy-afk-work-"));
        cleanups.push(async () => await rm(scratch, { recursive: true, force: true }));
        const repo = join(scratch, "repo");
        await mkdir(repo);
        const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init", "-q");
        git("config", "core.autocrlf", "false");
        await writeFile(join(repo, "README.md"), "repo\n");
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
        const installation = await afkInstallation(agency.url, {
            extra: { ORKEST_AFK_REPO: repo },
        });
        const runtime = await afkHappy(installation, new ScriptedProvider([textTurn("Done.")]));
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");
        expect(await readFile(join(repo, "README.md"), "utf8")).toBe("repo\n");
        const task = await runtime.modules.tasks.get(dbCtx(runtime), afkDerivedId("t", RUN));
        expect(await realpath(task!.path)).not.toBe(await realpath(repo));
        const worktrees = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
            encoding: "utf8",
        })
            .split(/\r?\n/)
            .filter((line) => line.startsWith("worktree "));
        expect(worktrees).toEqual([`worktree ${(await realpath(repo)).replaceAll("\\", "/")}`]);
    }, 90_000);

    it("runs a mapped ticket inside its pinned project and applies its committed write rule", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "approved", projectId: "film-1" });
        const scratch = await mkdtemp(join(tmpdir(), "happy-afk-project-"));
        cleanups.push(async () => await rm(scratch, { recursive: true, force: true }));
        const writableRoot = join(scratch, "projects");
        const repo = join(writableRoot, "film-one");
        const output = join(repo, "output");
        const deliverables = join(repo, "deliverables");
        const privateFiles = join(repo, "private");
        await mkdir(output, { recursive: true });
        await mkdir(deliverables, { recursive: true });
        await mkdir(privateFiles, { recursive: true });
        const sibling = join(writableRoot, "film-two");
        await mkdir(sibling, { recursive: true });
        const escape = join(output, "alias");
        await symlink(sibling, escape, "junction");
        cleanups.push(
            async () => await unlink(escape).catch(() => rmdir(escape).catch(() => undefined)),
        );
        const settingsPath = join(repo, ".claude", "settings.json");
        const rolePath = join(repo, ".claude", "roles", "director.json");
        await mkdir(dirname(settingsPath), { recursive: true });
        await mkdir(dirname(rolePath), { recursive: true });
        await writeFile(
            settingsPath,
            JSON.stringify({
                permissions: {
                    allow: ["Bash(git status:*)"],
                    deny: ["Write(private/**)", "Write(.claude/**)"],
                },
            }),
        );
        await writeFile(
            rolePath,
            JSON.stringify({
                permissions: {
                    allow: ["Write(output/**)", "Write(deliverables/**)", "Write(private/**)"],
                    deny: [],
                },
            }),
        );
        const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init", "-q");
        git("config", "core.autocrlf", "false");
        git("add", ".");
        git(
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "trusted settings",
        );
        const policyRevision = git("rev-parse", "HEAD").toString().trim();
        await writeFile(
            settingsPath,
            JSON.stringify({ permissions: { allow: ["Write(denied/**)"] } }),
        );
        const projectsFile = join(scratch, "afk-projects.json");
        await writeFile(
            projectsFile,
            JSON.stringify({
                tenant: "tenant-1",
                writableRoot,
                projects: { "film-1": { path: repo, policyRevision, policyRole: "director" } },
            }),
        );
        const installation = await afkInstallation(agency.url, {
            extra: {
                ORKEST_AFK_TENANT: "tenant-1",
                ORKEST_AFK_PROJECTS_FILE: projectsFile,
            },
        });
        const runtime = await afkHappy(
            installation,
            new ScriptedProvider([
                writeHello(Promise.resolve(privateFiles)),
                writeHello(Promise.resolve(escape), "callwrite2"),
                writeHello(Promise.resolve(output), "callwrite3"),
                writeHello(Promise.resolve(deliverables), "callwrite4"),
                textTurn("Done."),
            ]),
        );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(agency.run.state, JSON.stringify(runtime.modules.orkestAfk.status)).toBe("proposed");
        expect(existsSync(join(output, "hello.txt")), JSON.stringify(agency.receipts())).toBe(true);
        expect(await readFile(join(output, "hello.txt"), "utf8")).toBe("hello");
        expect(await readFile(join(deliverables, "hello.txt"), "utf8")).toBe("hello");
        expect(await readFile(join(privateFiles, "hello.txt")).catch(() => "")).toBe("");
        expect(await readFile(join(sibling, "hello.txt")).catch(() => "")).toBe("");
        expect(agency.of("/approvals")).toHaveLength(1);
        expect(agency.progress()).toContain("Blocked outside the supported project scope: Write");
        const task = await runtime.modules.tasks.get(dbCtx(runtime), afkDerivedId("t", RUN));
        expect(await realpath(task!.path)).not.toBe(await realpath(repo));
    }, 90_000);

    it("asks before a confined read that the pinned project did not allow", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "approved", projectId: "film-1" });
        const scratch = await mkdtemp(join(tmpdir(), "happy-afk-read-"));
        cleanups.push(async () => await rm(scratch, { recursive: true, force: true }));
        const writableRoot = join(scratch, "projects");
        const repo = join(writableRoot, "film-one");
        await mkdir(join(repo, ".claude"), { recursive: true });
        await writeFile(join(repo, "notes.txt"), "inside the assigned film");
        await writeFile(
            join(repo, ".claude", "settings.json"),
            JSON.stringify({ permissions: { allow: [], deny: [] } }),
        );
        const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init", "-q");
        git("add", ".");
        git(
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "trusted settings",
        );
        const projectsFile = join(scratch, "afk-projects.json");
        await writeFile(
            projectsFile,
            JSON.stringify({
                tenant: "tenant-1",
                writableRoot,
                projects: {
                    "film-1": {
                        path: repo,
                        policyRevision: git("rev-parse", "HEAD").toString().trim(),
                    },
                },
            }),
        );
        const installation = await afkInstallation(agency.url, {
            extra: { ORKEST_AFK_TENANT: "tenant-1", ORKEST_AFK_PROJECTS_FILE: projectsFile },
        });
        const readTurn = () =>
            (async function* () {
                yield* toolCallTurn(
                    "callread1",
                    "Read",
                    JSON.stringify({ file_path: join(repo, "notes.txt") }),
                );
            })();
        const runtime = await afkHappy(
            installation,
            new ScriptedProvider([readTurn, textTurn("Done.")]),
        );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(agency.run.state, JSON.stringify(runtime.modules.orkestAfk.status)).toBe("proposed");
        expect(agency.of("/approvals")).toHaveLength(1);
        expect(agency.progress()).toContain("Approved: Read");
    }, 90_000);

    it("leaves a server-bound run pending when the trusted tenant map belongs to another tenant", async () => {
        const agency = await fakeAfkAgency({ projectId: "film-1" });
        const scratch = await mkdtemp(join(tmpdir(), "happy-afk-wrong-tenant-"));
        cleanups.push(async () => await rm(scratch, { recursive: true, force: true }));
        const projectsFile = join(scratch, "afk-projects.json");
        await writeFile(
            projectsFile,
            JSON.stringify({ tenant: "other-tenant", writableRoot: scratch, projects: {} }),
        );
        const installation = await afkInstallation(agency.url, {
            extra: { ORKEST_AFK_TENANT: "tenant-1", ORKEST_AFK_PROJECTS_FILE: projectsFile },
        });
        const runtime = await afkHappy(
            installation,
            new ScriptedProvider([textTurn("Do not start.")]),
        );
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect(agency.run.state).toBe("admitted");
        expect(agency.calls.some((call) => call.path.endsWith("/ack"))).toBe(false);
        expect(agency.calls.some((call) => call.path.endsWith("/claim"))).toBe(false);
        expect(runtime.modules.orkestAfk.status.lastError).toContain("does not match this worker");
        expect(await runtime.modules.tasks.list(dbCtx(runtime))).toHaveLength(0);
    }, 90_000);

    it("continues other queued projects when one run has no trusted mapping", async () => {
        const secondRunId = "0195f3a0-0000-7000-8000-000000000102";
        const secondIntentId = "0195f3a0-0000-7000-8000-0000000001ab";
        const agency = await fakeAfkAgency({
            projectId: "film-missing",
            additionalRuns: [
                { runId: secondRunId, intentId: secondIntentId, projectId: "film-good" },
            ],
        });
        const scratch = await mkdtemp(join(tmpdir(), "happy-afk-queue-"));
        cleanups.push(async () => await rm(scratch, { recursive: true, force: true }));
        const writableRoot = join(scratch, "projects");
        const repo = join(writableRoot, "film-good");
        await mkdir(join(repo, ".claude"), { recursive: true });
        await writeFile(
            join(repo, ".claude", "settings.json"),
            JSON.stringify({ permissions: { allow: [], deny: [] } }),
        );
        const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init", "-q");
        git("add", ".");
        git(
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "trusted settings",
        );
        const projectsFile = join(scratch, "afk-projects.json");
        await writeFile(
            projectsFile,
            JSON.stringify({
                tenant: "tenant-1",
                writableRoot,
                projects: {
                    "film-good": {
                        path: repo,
                        policyRevision: git("rev-parse", "HEAD").toString().trim(),
                    },
                },
            }),
        );
        const installation = await afkInstallation(agency.url, {
            extra: { ORKEST_AFK_TENANT: "tenant-1", ORKEST_AFK_PROJECTS_FILE: projectsFile },
        });
        const runtime = await afkHappy(installation, new ScriptedProvider([textTurn("Done.")]));
        const secondRun = agency.runs.find((candidate) => candidate.runId === secondRunId)!;
        await expect.poll(() => secondRun.state, { timeout: 30_000 }).toBe("proposed");
        expect(agency.run.state).toBe("admitted");
        const acknowledgements = agency.of("/ack");
        expect(acknowledgements).toHaveLength(1);
        expect(acknowledgements[0]?.path).toBe(`/internal/agency/intents/${secondIntentId}/ack`);
        expect(agency.receipts().map((receipt) => receipt.runId)).toEqual([secondRunId]);
        expect(runtime.modules.orkestAfk.status.lastError).toContain(
            "no valid trusted repository mapping",
        );
    }, 90_000);

    it("refuses to own AFK runs unless the installation is attended-only", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url, { attendedOnly: false });
        for (const [name, value] of Object.entries(installation.environment)) {
            if (name.startsWith("ORKEST_AFK_") && value !== undefined) vi.stubEnv(name, value);
        }
        const config = await testConfigRootedAt(
            installation.home,
            "[features]\nattended_only = false\n",
        );
        expect(config.orkestAfk).toMatchObject({ url: agency.url, workerId: "happy-afk:test" });
        vi.stubEnv("ORKEST_AFK_RUN", undefined);
        const module = new OrkestAfkModule(config, {} as never);
        cleanups.push(async () => await module.close());
        const db = moduleDatabase([], "orkest-afk-refuse");
        cleanups.push(() => db.close());
        await db.ready;
        await module.beforeStart(db.context, {} as never).afterStart?.(db.context, {} as never);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect(agency.calls).toEqual([]);
        expect(module.status).toMatchObject({
            state: "refused",
            lastError: "Orkest AFK runs need [features] attended_only = true.",
        });
        // A Happy that owns no unattended run is not an unattended process.
        expect(process.env.ORKEST_AFK_RUN).toBeUndefined();
    }, 30_000);

    it("stays off without a readable worker token file, never falling back to a tokenless lane", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-afk-off-"));
        cleanups.push(async () => await rm(root, { recursive: true, force: true }));
        const tokenFile = join(root, "service.token");
        await writeFile(tokenFile, SERVICE_TOKEN);
        const workerTokenFile = join(root, "worker.token");
        await writeFile(workerTokenFile, WORKER_TOKEN);
        vi.stubEnv("ORKEST_AFK_URL", "http://127.0.0.1:9/");
        vi.stubEnv("ORKEST_AFK_TOKEN_FILE", tokenFile);
        vi.stubEnv("ORKEST_AFK_MODEL", `scripted:${MODEL}`);
        const settings = "[features]\nattended_only = true\n";

        vi.stubEnv("ORKEST_AFK_WORKER_TOKEN_FILE", workerTokenFile);
        const on = (await testConfigRootedAt(root, settings)).orkestAfk;
        expect(on).toMatchObject({
            url: "http://127.0.0.1:9",
            workerToken: WORKER_TOKEN,
            model: `scripted:${MODEL}`,
        });
        expect(on?.workerId).toMatch(/^happy-afk:/);
        // A stale launcher's service-token file is never read: the worker holds only its own token.
        expect(on).not.toHaveProperty("token");
        expect(JSON.stringify(on)).not.toContain(SERVICE_TOKEN);
        vi.stubEnv("ORKEST_AFK_TOKEN_FILE", "");
        expect((await testConfigRootedAt(root, settings)).orkestAfk).toMatchObject({
            workerToken: WORKER_TOKEN,
        });

        vi.stubEnv("ORKEST_AFK_WORKER_TOKEN_FILE", "");
        expect((await testConfigRootedAt(root, settings)).orkestAfk).toBeUndefined();
        vi.stubEnv("ORKEST_AFK_WORKER_TOKEN_FILE", join(root, "missing.token"));
        const off = await testConfigRootedAt(root, settings);
        expect(off.orkestAfk).toBeUndefined();
        expect(new OrkestAfkModule(off, {} as never).status.state).toBe("disabled");
    });
});

/** sha256 of the arguments as stable JSON (keys sorted), as the worker computes it. */
function inputSha256(value: unknown): string {
    const stable = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(stable)
            : v !== null && typeof v === "object"
              ? Object.fromEntries(
                    Object.keys(v as Record<string, unknown>)
                        .sort()
                        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
                )
              : v;
    return createHash("sha256")
        .update(JSON.stringify(stable(value)))
        .digest("hex");
}

/** A runtime whose scripted model calls Write in the run's work directory, then finishes. */
async function gatedRun(
    installation: Installation,
    after: ScriptedTurn[] = [textTurn("Created hello.txt.")],
) {
    let started!: (runtime: HappyAgentRuntime) => void;
    const ready = new Promise<HappyAgentRuntime>((resolve) => (started = resolve));
    const workDir = workDirOf(ready);
    const provider = new ScriptedProvider([writeHello(workDir), ...after]);
    const runtime = await afkHappy(installation, provider);
    started(runtime);
    return { runtime, provider, workDir: await workDir };
}

const writeKey = (path: string) =>
    `Write:${inputSha256({ file_path: path, content: "hello" }).slice(0, 32)}`;

describe("Orkest AFK read scope (GHO-189 audit)", () => {
    it("runs a read unasked only when every path it names stays inside the run's folder", () => {
        const dir = join(tmpdir(), "afk-scope", "orkest_afk_x");
        expect(afkReadStaysInside("Glob", dir, { pattern: "*" })).toBe(true);
        expect(afkReadStaysInside("Glob", dir, {})).toBe(true);
        expect(afkReadStaysInside("Read", dir, { file_path: "hello.txt" })).toBe(true);
        expect(afkReadStaysInside("Read", dir, { file_path: join(dir, "sub", "a.md") })).toBe(true);
        // Grep's pattern is a regular expression, not a path.
        expect(afkReadStaysInside("Grep", dir, { pattern: "^/api|\.\./", path: "src" })).toBe(true);
        expect(
            afkReadStaysInside("Read", dir, { file_path: join(dir, "..", "orkest.token") }),
        ).toBe(false);
        expect(afkReadStaysInside("Read", dir, { file_path: "../../orkest.token" })).toBe(false);
        expect(
            afkReadStaysInside("Read", dir, { file_path: join(tmpdir(), "other", ".env") }),
        ).toBe(false);
        expect(afkReadStaysInside("Glob", dir, { pattern: "../**/*.token" })).toBe(false);
        expect(afkReadStaysInside("Glob", dir, { pattern: "*", path: tmpdir() })).toBe(false);
        expect(afkReadStaysInside("Grep", dir, { pattern: "x", path: tmpdir() })).toBe(false);
        expect(afkReadStaysInside("read_file", dir, { path: "~/.ssh/id_rsa" })).toBe(false);
        expect(afkReadStaysInside("Read", dir, { file_path: 42 })).toBe(false);
        expect(afkReadStaysInside("Read", dir, { file_path: [join(tmpdir(), "x")] })).toBe(false);
    });

    it("asks a person before a read outside the run's folder, such as its own token file", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "denied" });
        const installation = await afkInstallation(agency.url);
        const outside = join(installation.home, "orkest-afk.token");
        const provider = new ScriptedProvider([
            toolCallTurn("callread1", "Read", JSON.stringify({ file_path: outside })),
            textTurn("Stopping."),
        ]);
        await afkHappy(installation, provider);
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("declined");
        expect([...agency.approvals.values()]).toMatchObject([{ tool: "Read", state: "denied" }]);
        expect(agency.receipts()[0]).toMatchObject({
            outcome: "declined",
            toolCalls: [{ tool: "Read", decision: "denied" }],
        });
        const seen = JSON.stringify(
            provider.sessions.flatMap((session) => session.requests.map((r) => r.context.messages)),
        );
        expect(seen).not.toContain(SERVICE_TOKEN);
    }, 90_000);
});

describe("Orkest AFK tool policy (GHO-189.3.2)", () => {
    it("runs a read-only tool without asking anyone", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url);
        await afkHappy(
            installation,
            new ScriptedProvider([
                toolCallTurn("callglob1", "Glob", JSON.stringify({ pattern: "*" })),
                textTurn("Listed the folder."),
            ]),
        );
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");
        expect(agency.calls.filter((c) => c.path.includes("/approvals"))).toHaveLength(0);
        expect(agency.receipts()[0]).toMatchObject({
            outcome: "proposed",
            toolCalls: [
                { tool: "Glob", inputSha256: inputSha256({ pattern: "*" }), decision: "ran" },
            ],
            approvals: [],
        });
    }, 90_000);

    it("asks before a gated call, waits, and runs it once a person approves", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url);
        const { workDir } = await gatedRun(installation);
        const hello = join(workDir, "hello.txt");

        await expect.poll(() => agency.approvals.size, { timeout: 30_000 }).toBe(1);
        const [row] = [...agency.approvals.values()];
        expect(row).toMatchObject({ tool: "Write", key: writeKey(hello), state: "pending" });
        expect(row!.inputSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row!.inputSha256).toBe(inputSha256({ file_path: hello, content: "hello" }));
        expect(row!.inputPreview.length).toBeLessThanOrEqual(4_000);
        expect(agency.of("/approvals")[0]?.body).toMatchObject({ fence: 1, key: row!.key });
        await expect
            .poll(() => agency.progress(), { timeout: 10_000 })
            .toContain("Waiting for approval: Write");
        // It waits: re-reading the approval, with nothing written.
        await expect
            .poll(() => agency.of(`/approvals/${encodeURIComponent(row!.key)}`).length, {
                timeout: 10_000,
            })
            .toBeGreaterThanOrEqual(1);
        expect(existsSync(hello)).toBe(false);
        expect(agency.run.state).toBe("running");

        row!.state = "approved";
        row!.answeredBy = "human-1";
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");
        expect(await readFile(hello, "utf8")).toBe("hello");
        expect(agency.receipts()[0]).toMatchObject({
            outcome: "proposed",
            summary: "Created hello.txt.",
            toolCalls: [{ tool: "Write", inputSha256: row!.inputSha256, decision: "approved" }],
            approvals: [{ key: row!.key, tool: "Write", state: "approved", answeredBy: "human-1" }],
        });
        expect(agency.completes()).toEqual([
            { fence: 1, proposed: true, consumed: 1, reason: "done" },
        ]);
    }, 90_000);

    it("tells the model a declined call did not run and ends the run declined", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url);
        const { runtime, provider, workDir } = await gatedRun(installation, [
            textTurn("Understood; stopping."),
        ]);
        await expect.poll(() => agency.approvals.size, { timeout: 30_000 }).toBe(1);
        const [row] = [...agency.approvals.values()];
        row!.state = "denied";
        row!.answeredBy = "human-1";

        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("declined");
        expect(agency.completes()).toEqual([
            {
                fence: 1,
                proposed: false,
                consumed: 1,
                reason: "approval_denied",
                outcome: "declined",
            },
        ]);
        expect(existsSync(join(workDir, "hello.txt"))).toBe(false);
        // The model was answered with an error saying a person declined it.
        const seen = JSON.stringify(
            provider.sessions.flatMap((session) => session.requests.map((r) => r.context.messages)),
        );
        expect(seen).toContain("A person declined this action");
        expect(
            (await runtime.modules.tasks.get(dbCtx(runtime), afkDerivedId("t", RUN)))?.status,
        ).toBe("archived");
        const paths = agency.calls.map((call) => call.path);
        expect(paths.indexOf(`/internal/agency/runs/${RUN}/artifacts`)).toBeLessThan(
            paths.indexOf(`/internal/agency/runs/${RUN}/complete`),
        );
        expect(agency.receipts()[0]).toMatchObject({
            outcome: "declined",
            toolCalls: [{ tool: "Write", decision: "denied" }],
            approvals: [{ key: row!.key, tool: "Write", state: "denied", answeredBy: "human-1" }],
        });
    }, 90_000);

    it("ends the run when a person asks Orkest to stop it", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url);
        const runtime = await afkHappy(installation, new ScriptedProvider([hangingTurn]));
        await expect.poll(() => agency.progress()[0], { timeout: 30_000 }).toBe("Started");
        agency.run.stopRequestedAt = new Date().toISOString();

        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("declined");
        expect(agency.completes()).toEqual([
            {
                fence: 1,
                proposed: false,
                consumed: 1,
                reason: "stopped_by_person",
                outcome: "declined",
            },
        ]);
        expect(agency.receipts()[0]).toMatchObject({ runId: RUN, outcome: "stopped" });
        expect(
            (await runtime.modules.tasks.get(dbCtx(runtime), afkDerivedId("t", RUN)))?.status,
        ).toBe("archived");
    }, 90_000);

    it("does not ask again for a call a person already answered before a restart", async () => {
        const agency = await fakeAfkAgency();
        const installation = await afkInstallation(agency.url);
        const first = await gatedRun(installation, []);
        await expect.poll(() => agency.approvals.size, { timeout: 30_000 }).toBe(1);
        await first.runtime.closeForTest();
        const [row] = [...agency.approvals.values()];
        row!.state = "approved";
        row!.answeredBy = "human-1";

        const callsBefore = agency.calls.length;
        const second = await gatedRun(installation, [textTurn("Created hello.txt.")]);
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");
        const later = agency.calls.slice(callsBefore);
        const asks = agency.of(`/afk/${RUN}/approvals`);
        expect(asks).toHaveLength(2);
        expect(new Set(asks.map((c) => (c.body as { key: string }).key))).toEqual(
            new Set([row!.key]),
        );
        expect(agency.approvals.size).toBe(1);
        // The stored answer came back with the replay: no waiting, no re-reading.
        expect(later.some((c) => c.method === "GET" && c.path.includes("/approvals/"))).toBe(false);
        expect(
            later
                .filter((c) => c.path.endsWith("/publish"))
                .map((c) => (c.body as { payload: { text: string } }).payload.text),
        ).not.toContain("Waiting for approval: Write");
        expect(await readFile(join(second.workDir, "hello.txt"), "utf8")).toBe("hello");
        expect(agency.completes()).toEqual([
            { fence: 2, proposed: true, consumed: 1, reason: "done" },
        ]);
        expect(agency.receipts()[0]).toMatchObject({
            toolCalls: [{ tool: "Write", decision: "approved" }],
        });
    }, 120_000);
});
