import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
async function fakeAfkAgency(options: { autoAnswer?: "approved" | "denied" } = {}) {
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
        workProvider: "orkest",
        workExternalId: "WAR-9",
        createdBy: "human-1",
        createdAt: "2026-11-22T10:00:00Z",
        stopRequestedAt: null as string | null,
        intentId: INTENT as string | null,
        ownerJobRef: null as string | null,
        leaseHolder: null as string | null,
        fence: 0,
    };
    let intent: "pending" | "acknowledged" = "pending";
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
        if (header("x-ghost-service-token") !== SERVICE_TOKEN) return send(401, {});
        if (header("x-orkest-worker-token") !== WORKER_TOKEN) return send(401, {});
        const path = url.pathname;
        const fenced = () => (body as { fence?: number } | null)?.fence === run.fence;
        const live = () => run.state === "running";
        if (path === "/internal/agency/afk/pending") {
            return send(200, intent === "pending" ? [run] : []);
        }
        if (path === "/internal/agency/afk/active") {
            const mine = intent === "acknowledged" && ["dispatched", "running"].includes(run.state);
            return send(200, mine ? [run] : []);
        }
        if (path === `/internal/agency/intents/${INTENT}/ack`) {
            intent = "acknowledged";
            run.ownerJobRef = (body as { ownerJobRef: string }).ownerJobRef;
            run.state = "dispatched";
            return send(200, { status: "Ok" });
        }
        if (path === `/internal/agency/runs/${RUN}/claim`) {
            if (!["dispatched", "running"].includes(run.state)) return send(409, {});
            run.state = "running";
            run.fence += 1;
            run.leaseHolder = (body as { workerId: string }).workerId;
            return send(200, {
                status: "Ok",
                runId: RUN,
                attempt: run.fence,
                fenceToken: run.fence,
                expiresAt: "2026-11-22T10:02:00Z",
            });
        }
        if (path === `/internal/agency/runs/${RUN}/heartbeat`) {
            return fenced() && live() ? send(200, { status: "Ok" }) : send(409, {});
        }
        if (path === `/internal/agency/runs/${RUN}/publish`) {
            return fenced() && live() ? send(200, { status: "Ok" }) : send(409, {});
        }
        if (path === `/internal/agency/runs/${RUN}/artifacts`) {
            return fenced() && live() ? send(201, { artifactId: "art-1" }) : send(409, {});
        }
        if (path === `/internal/agency/afk/${RUN}/approvals` && request.method === "POST") {
            if (!fenced() || !live()) return send(409, {});
            const ask = body as Omit<ApprovalRow, "approvalId" | "runId" | "state">;
            const existing = approvals.get(ask.key);
            if (existing) return send(200, existing);
            const row: ApprovalRow = {
                approvalId: `approval-${approvals.size + 1}`,
                runId: RUN,
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
            approvals.set(row.key, row);
            return send(200, row);
        }
        const approval = new RegExp(`^/internal/agency/afk/${RUN}/approvals/(.+)$`).exec(path);
        if (approval && request.method === "GET") {
            const row = approvals.get(decodeURIComponent(approval[1]!));
            return row ? send(200, row) : send(404, {});
        }
        if (path === `/internal/agency/runs/${RUN}/complete`) {
            if (!fenced() || !live()) return send(409, {});
            const done = body as { proposed: boolean; outcome?: string };
            run.state = done.proposed ? "proposed" : (done.outcome ?? "failed");
            return send(200, { status: "Ok" });
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
    const tokenFile = join(home, "orkest-afk.token");
    await writeFile(tokenFile, SERVICE_TOKEN);
    const workerTokenFile = join(home, "orkest-afk-worker.token");
    await writeFile(workerTokenFile, `${WORKER_TOKEN}\n`);
    const environment = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORKEST_AFK_URL: agencyUrl,
        ORKEST_AFK_TOKEN_FILE: tokenFile,
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
        // Every call carried both the service token and this worker's own token.
        expect(agency.calls.length).toBeGreaterThan(5);
        for (const call of agency.calls) {
            expect(call.serviceToken).toBe(SERVICE_TOKEN);
            expect(call.workerToken).toBe(WORKER_TOKEN);
        }
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

    it("gives each run its own git worktree under the configured work root", async () => {
        const agency = await fakeAfkAgency({ autoAnswer: "approved" });
        const scratch = await mkdtemp(join(tmpdir(), "happy-afk-work-"));
        cleanups.push(async () => await rm(scratch, { recursive: true, force: true }));
        const repo = join(scratch, "repo");
        await mkdir(repo);
        const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init", "-q");
        await writeFile(join(repo, "README.md"), "repo\n");
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
        const workRoot = join(scratch, "runs");
        const installation = await afkInstallation(agency.url, {
            extra: { ORKEST_AFK_WORK_ROOT: workRoot, ORKEST_AFK_REPO: repo },
        });
        const runtime = await afkHappy(installation, new ScriptedProvider([textTurn("Done.")]));
        await expect.poll(() => agency.run.state, { timeout: 30_000 }).toBe("proposed");
        const runDir = join(workRoot, afkFolderName(RUN));
        expect(existsSync(join(runDir, ".git"))).toBe(true);
        expect(await readFile(join(runDir, "README.md"), "utf8")).toBe("repo\n");
        const task = await runtime.modules.tasks.get(dbCtx(runtime), afkDerivedId("t", RUN));
        expect(await realpath(task!.path)).toBe(await realpath(runDir));
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
            token: SERVICE_TOKEN,
            workerToken: WORKER_TOKEN,
            model: `scripted:${MODEL}`,
        });
        expect(on?.workerId).toMatch(/^happy-afk:/);

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
void inputSha256;
