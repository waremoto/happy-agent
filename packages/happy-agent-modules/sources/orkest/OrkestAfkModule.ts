import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath, rmdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
    withAgentDatabase,
    type AgentBaseToolCall,
    type AgentBaseToolCallDecision,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { MessageMode } from "@slopus/happy-agent-client";
import {
    providerModelFamily,
    type SessionEvent,
    type SessionReasoningEffort,
} from "@slopus/happy-providers";
import { delay, detach, isAbortedError, withLifetime, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { TasksModule, type TaskRecord } from "../tasks/index.js";
import {
    OrkestAfkClient,
    type AfkApproval,
    type AfkCompletion,
    type AfkRun,
    type OrkestAfkEndpoint,
} from "./impl/OrkestAfkClient.js";
import {
    acquireOrkestAfkProjectLock,
    projectPathsResolveInside,
    projectPathIsProtected,
    projectRuleDecision,
    resolveOrkestAfkProject,
    type OrkestAfkProject,
    type OrkestAfkProjectLockRelease,
} from "./impl/OrkestAfkProjects.js";

/** How often the owner reads Orkest, and how often a waiting call re-reads its approval. */
const POLL_MS = 2_000;
const APPROVAL_POLL_MS = 2_000;
/** The lease asked for at each claim and heartbeat, and how often it is renewed. */
const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;
/** Ordinary progress lines are rate-limited; start, approval and end lines always go out. */
const PROGRESS_MS = 5_000;
/** A declined run whose model keeps going is ended anyway after this long. */
const DECLINE_GRACE_MS = 60_000;
const SUMMARY_LIMIT = 4_000;
const PREVIEW_LIMIT = 4_000;

/**
 * Tools that only read; they run without asking when what they read is inside the run's folder
 * (`afkReadStaysInside`). The names are each vendor's
 * own (Claude/Kimi `Read`, `Glob`, `Grep`, `ReadMediaFile`; Grok `read_file`, `list_dir`, `grep`;
 * Codex `view_image`). Everything else, shells included, waits for a person's approval.
 */
export const AFK_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    "Read",
    "Glob",
    "Grep",
    "ReadMediaFile",
    "read_file",
    "list_dir",
    "grep",
    "view_image",
]);

/**
 * The arguments of the read-only tools that name a path (each vendor's spelling). `pattern` is a path
 * only for the listing tools; Grep's `pattern` is a regular expression.
 */
const AFK_PATH_ARGUMENTS: ReadonlySet<string> = new Set([
    "file_path",
    "path",
    "paths",
    "notebook_path",
    "directory",
    "dir",
    "target_directory",
    "absolute_path",
    "image_path",
]);
const AFK_PATTERN_IS_PATH: ReadonlySet<string> = new Set(["Glob", "list_dir"]);

/**
 * True when every path a read-only call names resolves inside the run's own folder (GHO-189 audit).
 * Only then does it run unasked; a read anywhere else (the worker's token files, the operator's
 * `.env`, another run) goes to a person like any other action. Anything it cannot read as a path
 * counts as outside, so the check fails toward asking.
 */
export function afkReadStaysInside(tool: string, directory: string, args: unknown): boolean {
    if (args === null || args === undefined) return true;
    if (typeof args !== "object" || Array.isArray(args)) return false;
    const root = resolve(directory);
    for (const [name, value] of Object.entries(args as Record<string, unknown>)) {
        const isPath =
            AFK_PATH_ARGUMENTS.has(name) || (name === "pattern" && AFK_PATTERN_IS_PATH.has(tool));
        if (!isPath || value === undefined || value === null) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const candidate of values) {
            if (typeof candidate !== "string") return false;
            if (candidate.trim() === "") continue;
            if (candidate.startsWith("~")) return false;
            const inside = relative(root, resolve(root, candidate));
            if (inside.startsWith("..") || isAbsolute(inside)) return false;
        }
    }
    return true;
}

const execFileAsync = promisify(execFile);

type Outcome = "proposed" | "declined" | "stopped" | "failed";

interface ToolCallRecord {
    readonly tool: string;
    readonly inputSha256: string;
    decision: "ran" | "approved" | "denied";
}

interface HeldRun {
    readonly runId: string;
    readonly title: string;
    readonly workLabel: string;
    readonly taskId: string;
    readonly agentId: string;
    /** The task folder the agent works in; read-only tools run unasked only inside it. */
    readonly directory: string;
    readonly project: OrkestAfkProject | undefined;
    readonly releaseProjectLock: OrkestAfkProjectLockRelease | undefined;
    fence: number;
    lastHeartbeat: number;
    lastProgress: number;
    stopRequested: boolean;
    lost: boolean;
    /** Set when a person declined a call: the run ends declined once the loop settles. */
    declinedAt?: number;
    ending: Promise<void> | undefined;
    receiptPublished: boolean;
    readonly toolCalls: ToolCallRecord[];
    readonly approvals: Map<
        string,
        { key: string; tool: string; state: string; answeredBy: string | null }
    >;
    turns: number;
    text: string;
    lastText: string;
    deadlineAt?: number;
    deadlineExpired: boolean;
    deadlineTimer?: ReturnType<typeof setTimeout>;
    deadlineStop?: Promise<void>;
}

/**
 * Happy as the unattended (AFK) owner of Orkest runs (GHO-189.3).
 *
 * Orkest admits an unattended run and leaves a dispatch intent; this module drains it into a Happy
 * task with identities derived from the run, acknowledges the intent with that task, claims the run
 * and sends the brief as the task's first message. The agent then works on its own, but only the
 * read-only tools run directly: every other call is put to a person through Orkest's approval
 * endpoint and waits for the answer. When the loop settles the module publishes a receipt and
 * completes the run as proposed; a denial, a stop request or a failure completes it accordingly.
 *
 * Enabled only with `ORKEST_AFK_URL`, `ORKEST_AFK_WORKER_TOKEN_FILE` and
 * `ORKEST_AFK_MODEL`, and only on an attended-only installation: Orkest's queue is the scheduler.
 */
export class OrkestAfkModule implements AgentModule {
    readonly name = "orkest-afk";
    readonly #config: ConfigModule;
    readonly #tasks: TasksModule;
    readonly #held = new Map<string, HeldRun>();
    readonly #stop = new AbortController();
    #agents: AgentSystemRef | undefined;
    #client: OrkestAfkClient | undefined;
    #root: Context | undefined;
    #loop: Promise<void> | undefined;
    #status: "disabled" | "refused" | "running" = "disabled";
    #lastError: string | null = null;

    constructor(config: ConfigModule, tasks: TasksModule) {
        this.#config = config;
        this.#tasks = tasks;
    }

    /** For diagnostics: whether the owner runs, how many runs it holds and the last failure. */
    get status(): { state: string; runs: number; lastError: string | null } {
        return { state: this.#status, runs: this.#held.size, lastError: this.#lastError };
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            beforeToolCall: (hookCtx, scope, call) => this.#beforeToolCall(hookCtx, scope, call),
            onEvent: (_hookCtx, scope, event) => this.#observe(scope.agent.id, event),
            afterTurn: (_hookCtx, scope) => {
                const held = this.#byAgent(scope.agent.id);
                if (held !== undefined) held.turns += 1;
                return undefined;
            },
            afterAgentSettled: (hookCtx, scope, settlement) => {
                const held = this.#byAgent(scope.agent.id);
                if (held === undefined || held.ending !== undefined) return;
                if (this.#stop.signal.aborted || hookCtx.lifetime?.aborted) return;
                if (held.lost || held.stopRequested) return;
                if (this.#deadlineReached(held)) {
                    void this.#expireDeadline(held);
                    return;
                }
                // Not awaited: the settlement hook must not wait on Orkest.
                void this.#end(
                    held,
                    held.declinedAt !== undefined
                        ? "declined"
                        : settlement.error === undefined
                          ? "proposed"
                          : "failed",
                    settlement.error,
                );
            },
            afterStart: () => {
                const endpoint = this.#config.orkestAfk;
                if (endpoint === undefined) return;
                if (this.#config.attendedOnly !== true) {
                    // A Happy that could start work itself would be a second scheduler.
                    this.#status = "refused";
                    this.#lastError = "Orkest AFK runs need [features] attended_only = true.";
                    return;
                }
                const mode = this.#mode(endpoint);
                if (typeof mode === "string") {
                    this.#status = "refused";
                    this.#lastError = mode;
                    return;
                }
                // Before the first run is drained, so no run's shell starts unmarked.
                this.#config.markUnattendedProcess();
                const root = withAgentDatabase(detach(ctx).named("orkest-afk-owner"), ctx.db);
                const lifetime =
                    ctx.lifetime === undefined
                        ? this.#stop.signal
                        : AbortSignal.any([ctx.lifetime, this.#stop.signal]);
                this.#root = withLifetime(root, lifetime);
                this.#client = new OrkestAfkClient(endpoint);
                this.#status = "running";
                this.#loop = this.#run(this.#root, this.#client, endpoint, mode);
            },
        };
    };

    async close(): Promise<void> {
        this.#stop.abort();
        await this.#loop?.catch(() => undefined);
        await Promise.all(
            [...this.#held.values()].map(async (held) => {
                await held.ending?.catch(() => undefined);
                held.lost = true;
                await held.releaseProjectLock?.();
            }),
        );
    }

    /** The mode every AFK task opens with, or why there is none. */
    #mode(endpoint: OrkestAfkEndpoint): MessageMode | string {
        const separator = endpoint.model.indexOf(":");
        let providerId: string | undefined;
        let modelId: string;
        if (separator > 0) {
            providerId = endpoint.model.slice(0, separator);
            modelId = endpoint.model.slice(separator + 1);
        } else {
            modelId = endpoint.model;
        }
        let effort = "medium";
        try {
            const known = this.#config.models.find(
                (model) =>
                    model.id === modelId &&
                    (providerId === undefined || model.providerId === providerId),
            );
            providerId ??= known?.providerId;
            if (known !== undefined) effort = known.defaultEffort;
        } catch {
            // No catalog yet: an explicit provider still works.
        }
        if (providerId === undefined || modelId.length === 0) {
            return "ORKEST_AFK_MODEL must be <providerId>:<modelId> or a model id the catalog knows.";
        }
        if (providerModelFamily(modelId) === "foreign") {
            // A native harness runs its own tools, so no call of it could be put to a person.
            return "ORKEST_AFK_MODEL names a native agent harness; AFK runs need a Happy-run model.";
        }
        return {
            providerId,
            modelId,
            effort,
            serviceTier: null,
            permissionMode: "workspace_write",
        };
    }

    async #run(
        ctx: Context,
        client: OrkestAfkClient,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
    ): Promise<void> {
        while (!this.#stop.signal.aborted) {
            try {
                await this.#tick(ctx, client, endpoint, mode);
            } catch (error) {
                if (isAbortedError(error) || this.#stop.signal.aborted) return;
                // Orkest or the task store was unavailable; the next tick retries from durable state.
                this.#lastError = error instanceof Error ? error.message : String(error);
            }
            try {
                await delay(ctx, POLL_MS);
            } catch {
                return;
            }
        }
    }

    async #tick(
        ctx: Context,
        client: OrkestAfkClient,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
    ): Promise<void> {
        let failedRun = false;
        // Runs this worker already holds, including after its own restart.
        for (const run of await client.active()) {
            if (this.#stop.signal.aborted) return;
            try {
                const held =
                    this.#held.get(run.runId) ??
                    (await this.#reclaim(ctx, client, endpoint, mode, run));
                if (held === undefined || held.ending !== undefined) continue;
                if (run.stopRequestedAt !== null) {
                    held.stopRequested = true;
                    await this.#end(held, "stopped");
                }
                if (held !== undefined && this.#deadlineReached(held))
                    await this.#expireDeadline(held);
            } catch (error) {
                if (isAbortedError(error) || this.#stop.signal.aborted) return;
                failedRun = true;
                this.#lastError = error instanceof Error ? error.message : String(error);
            }
        }
        for (const run of await client.pending()) {
            if (this.#stop.signal.aborted) return;
            if (run.intentId === null || this.#held.has(run.runId)) continue;
            try {
                await this.#start(ctx, client, endpoint, mode, run, run.intentId);
            } catch (error) {
                if (isAbortedError(error) || this.#stop.signal.aborted) return;
                failedRun = true;
                this.#lastError = error instanceof Error ? error.message : String(error);
            }
        }
        const now = Date.now();
        for (const held of this.#held.values()) {
            try {
                if (held.ending !== undefined) continue;
                if (this.#deadlineReached(held)) {
                    await this.#expireDeadline(held);
                    continue;
                }
                if (held.releaseProjectLock !== undefined && !held.releaseProjectLock.isHeld()) {
                    held.lost = true;
                    failedRun = true;
                    this.#lastError = `Project lock lost for ${held.workLabel}.`;
                    await this.#end(held, "failed", "project lock lost");
                    continue;
                }
                if (held.declinedAt !== undefined && now - held.declinedAt > DECLINE_GRACE_MS) {
                    await this.#end(held, "declined");
                    continue;
                }
                if (now - held.lastHeartbeat < HEARTBEAT_MS) continue;
                const result = await client.heartbeat(held.runId, held.fence, LEASE_SECONDS);
                if (result.ok) held.lastHeartbeat = now;
                else if (result.final) await this.#drop(ctx, held);
            } catch (error) {
                if (isAbortedError(error) || this.#stop.signal.aborted) return;
                failedRun = true;
                this.#lastError = error instanceof Error ? error.message : String(error);
            }
        }
        if (!failedRun) this.#lastError = null;
    }

    async #start(
        ctx: Context,
        client: OrkestAfkClient,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
        run: AfkRun,
        intentId: string,
    ): Promise<void> {
        const project = await this.#project(endpoint, run);
        const releaseLock =
            project === undefined ? undefined : await acquireOrkestAfkProjectLock(project.lockPath);
        let transferred = false;
        try {
            const task = await this.#task(ctx, endpoint, mode, run, project);
            const ack = await client.acknowledge(intentId, task.id);
            if (!ack.ok) {
                if (ack.final) await this.#archive(ctx, task.id);
                return;
            }
            const lease = await client.claim(run.runId, LEASE_SECONDS);
            if (lease === undefined) {
                await this.#archive(ctx, task.id);
                return;
            }
            const attempt = await this.#acquireAttempt(client, run, lease.fence);
            if (attempt.started === false) {
                const held = this.#hold(run, task, lease.fence, project, releaseLock);
                transferred = true;
                await this.#end(held, "failed", "bounded run attempt was already consumed");
                return;
            }
            const held = this.#hold(run, task, lease.fence, project, releaseLock);
            this.#setDeadline(held, attempt.deadlineAt);
            transferred = true;
            if (attempt.deadlineAt !== undefined && attempt.deadlineAt <= Date.now()) {
                await this.#expireDeadline(held);
                return;
            }
            await this.#sendBrief(ctx, held, mode, run);
            await this.#progress(held, "Started", true);
        } finally {
            if (!transferred) await releaseLock?.();
        }
    }

    /**
     * After a restart: a new claim with a higher fence, so the previous process's fence stops
     * counting, then the derived task again. The brief is re-offered under its derived id, which
     * Happy accepts as `existing`; a run that had already started gets one continuation message.
     */
    async #reclaim(
        ctx: Context,
        client: OrkestAfkClient,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
        run: AfkRun,
    ): Promise<HeldRun | undefined> {
        const taskId = afkDerivedId("t", run.runId);
        if (run.ownerJobRef !== null && run.ownerJobRef !== taskId) return undefined;
        const project = await this.#project(endpoint, run);
        const releaseLock =
            project === undefined ? undefined : await acquireOrkestAfkProjectLock(project.lockPath);
        let transferred = false;
        try {
            const existingTask = await this.#tasks.get(ctx, taskId);
            if (existingTask !== undefined && project !== undefined) {
                await this.#assertTaskWorkingDirectory(ctx, existingTask, project);
            }
            const lease = await client.claim(run.runId, LEASE_SECONDS);
            if (lease === undefined) return undefined;
            const attempt = await this.#acquireAttempt(client, run, lease.fence);
            const task = await this.#task(ctx, endpoint, mode, run, project);
            const held = this.#hold(run, task, lease.fence, project, releaseLock);
            this.#setDeadline(held, attempt.deadlineAt);
            transferred = true;
            if (attempt.started === false) {
                await this.#end(held, "failed", "bounded run attempt was already consumed");
                return held;
            }
            if (attempt.deadlineAt !== undefined && attempt.deadlineAt <= Date.now()) {
                await this.#expireDeadline(held);
                return held;
            }
            const brief = await this.#sendBrief(ctx, held, mode, run);
            if (brief === "existing") {
                await this.#send(
                    ctx,
                    held,
                    mode,
                    "This Orkest worker restarted. Any tool call that was in flight when it stopped did not run. Continue the work item from where you stopped; when you are done, reply with a short summary of what you changed.",
                    afkDerivedId("m", `${run.runId}:resume:${lease.fence}`),
                );
                await this.#progress(held, "Resumed after a worker restart", true);
            } else {
                await this.#progress(held, "Started", true);
            }
            return held;
        } finally {
            if (!transferred) await releaseLock?.();
        }
    }

    async #project(
        endpoint: OrkestAfkEndpoint,
        run: AfkRun,
    ): Promise<OrkestAfkProject | undefined> {
        const projectId = run.projectId ?? undefined;
        if (projectId !== undefined) {
            return await resolveOrkestAfkProject(endpoint.projectsFile, endpoint.tenant, projectId);
        }
        if (endpoint.repo === undefined) return undefined;
        const projectPath = await realpath(endpoint.repo);
        return {
            id: projectPath,
            path: projectPath,
            policyRevision: "",
            allowedRules: [],
            deniedRules: [],
            lockPath: join(projectPath, ".run.lock"),
        };
    }

    #hold(
        run: AfkRun,
        task: TaskRecord,
        fence: number,
        project: OrkestAfkProject | undefined,
        releaseProjectLock: OrkestAfkProjectLockRelease | undefined,
    ): HeldRun {
        const held: HeldRun = {
            runId: run.runId,
            title: run.title,
            workLabel: run.workLabel,
            taskId: task.id,
            agentId: task.agentId,
            directory: project?.path ?? task.path,
            project,
            releaseProjectLock,
            fence,
            lastHeartbeat: Date.now(),
            lastProgress: 0,
            stopRequested: false,
            lost: false,
            ending: undefined,
            receiptPublished: false,
            toolCalls: [],
            approvals: new Map(),
            turns: 0,
            text: "",
            lastText: "",
            deadlineExpired: false,
        };
        this.#held.set(run.runId, held);
        return held;
    }

    async #acquireAttempt(
        client: OrkestAfkClient,
        run: AfkRun,
        fence: number,
    ): Promise<{ started: boolean; deadlineAt?: number }> {
        const bounded =
            run.wallSeconds != null ||
            run.maxAttempts != null ||
            run.attemptStartedAt != null ||
            run.deadlineAt != null;
        if (!bounded) return { started: true };
        if (
            run.wallSeconds == null ||
            !Number.isInteger(run.wallSeconds) ||
            run.maxAttempts !== 1 ||
            run.wallSeconds < 1 ||
            run.wallSeconds > 900
        ) {
            throw new Error("Bounded AFK run has invalid limits.");
        }
        // A consumed attempt in the feed is never continued, even if an old API mishandles POST.
        if (run.attemptStartedAt != null) {
            return { started: false };
        }
        const requestStartedAt = Date.now();
        const result = await client.acquireAttempt(run.runId, fence);
        if (!result.started) return { started: false };
        const deadline = Date.parse(result.deadlineAt ?? "");
        if (!Number.isFinite(deadline))
            throw new Error("Bounded AFK attempt returned no valid deadline.");
        return {
            started: true,
            deadlineAt: Math.min(deadline, requestStartedAt + run.wallSeconds * 1_000),
        };
    }

    #setDeadline(held: HeldRun, deadlineAt: number | undefined): void {
        if (deadlineAt === undefined) return;
        held.deadlineAt = deadlineAt;
        const remaining = Math.max(0, deadlineAt - Date.now());
        held.deadlineTimer = setTimeout(() => {
            void this.#expireDeadline(held);
        }, remaining);
        held.deadlineTimer.unref?.();
    }

    #deadlineReached(held: HeldRun): boolean {
        if (held.deadlineAt !== undefined && Date.now() >= held.deadlineAt)
            held.deadlineExpired = true;
        return held.deadlineExpired;
    }

    async #expireDeadline(held: HeldRun): Promise<void> {
        if (held.deadlineStop !== undefined) return await held.deadlineStop;
        held.deadlineExpired = true;
        held.deadlineStop = (async () => {
            const ctx = this.#root;
            if (ctx !== undefined) {
                try {
                    await this.#agents?.abort(ctx, held.agentId);
                } catch {
                    /* already settled */
                }
            }
            await this.#end(held, "failed", "bounded run deadline exceeded");
        })();
        await held.deadlineStop;
    }

    /** The run's task, created once: identities derived from the run make a repeat find it. */
    async #task(
        ctx: Context,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
        run: AfkRun,
        project: OrkestAfkProject | undefined,
    ): Promise<TaskRecord> {
        const task = await this.#tasks.create(ctx, {
            id: afkDerivedId("t", run.runId),
            workspaceId: afkDerivedId("w", run.runId),
            agentId: afkDerivedId("a", run.runId),
            name: run.title.slice(0, 120),
            folderName: afkFolderName(run.runId),
            mode,
            ...(run.projectId == null ? {} : { projectId: run.projectId }),
            ...(project === undefined ? {} : { workingDirectory: project.path }),
        });
        if (project === undefined) await this.#prepareWorkDirectory(endpoint, task);
        if (project !== undefined) await this.#assertTaskWorkingDirectory(ctx, task, project);
        return task;
    }

    async #assertTaskWorkingDirectory(
        ctx: Context,
        task: TaskRecord,
        project: OrkestAfkProject,
    ): Promise<void> {
        const config = await this.#agents?.config(ctx, task.agentId);
        const workingDirectory = config?.environment?.workingDirectory;
        if (typeof workingDirectory !== "string") {
            throw new Error("The bound project task has no recorded working directory.");
        }
        const actual = await realpath(workingDirectory).catch(() => "");
        const matches =
            actual !== "" &&
            (process.platform === "win32"
                ? resolve(actual).toLowerCase() === resolve(project.path).toLowerCase()
                : resolve(actual) === resolve(project.path));
        if (!matches) {
            throw new Error("The existing task is bound to a different project directory.");
        }
    }

    /**
     * The run's work directory is its task folder. With `ORKEST_AFK_WORK_ROOT` that folder links to
     * `<root>/<folder>`; with `ORKEST_AFK_REPO` the directory is a detached `git worktree` of it.
     * Both steps are idempotent, so a reclaim after a restart leaves an existing directory alone.
     */
    async #prepareWorkDirectory(endpoint: OrkestAfkEndpoint, task: TaskRecord): Promise<void> {
        let directory = task.path;
        if (endpoint.workRoot !== undefined) {
            directory = join(endpoint.workRoot, task.folderName);
            await mkdir(directory, { recursive: true });
            const existing = await lstat(task.path).catch(() => undefined);
            if (existing === undefined || !existing.isSymbolicLink()) {
                // The folder Happy made is still empty; it becomes a link to the run directory.
                if (existing !== undefined) await rmdir(task.path);
                await symlink(directory, task.path, "junction");
            }
        }
        if (endpoint.repo !== undefined && !existsSync(join(directory, ".git"))) {
            await execFileAsync(
                "git",
                ["-C", endpoint.repo, "worktree", "add", "--detach", directory],
                {
                    timeout: 120_000,
                    windowsHide: true,
                },
            );
        }
    }

    async #sendBrief(
        ctx: Context,
        held: HeldRun,
        mode: MessageMode,
        run: AfkRun,
    ): Promise<"created" | "existing"> {
        const heading = run.title.startsWith(run.workLabel)
            ? run.title
            : `${run.workLabel}: ${run.title}`;
        const text = [
            `Orkest work item ${heading}`,
            run.brief,
            "You are working unattended in this task's folder. Reading files inside this task's folder runs directly; every other action, reading elsewhere included, waits for a person to approve it in Orkest, and a declined action must not be retried or worked around. When you are done, reply with a short summary of what you changed.",
        ]
            .filter((part) => part.trim().length > 0)
            .join("\n\n")
            .slice(0, 100_000);
        return await this.#send(ctx, held, mode, text, afkDerivedId("m", run.runId));
    }

    async #send(
        ctx: Context,
        held: HeldRun,
        mode: MessageMode,
        text: string,
        id: string,
    ): Promise<"created" | "existing"> {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The agent system is not ready.");
        if (this.#deadlineReached(held)) {
            void this.#expireDeadline(held);
            throw new Error("The bounded run deadline passed before message dispatch.");
        }
        const sendCtx =
            held.deadlineAt === undefined
                ? ctx
                : withLifetime(
                      ctx,
                      AbortSignal.any([
                          ...(ctx.lifetime === undefined ? [] : [ctx.lifetime]),
                          this.#stop.signal,
                          AbortSignal.timeout(Math.max(1, held.deadlineAt - Date.now())),
                      ]),
                  );
        const acceptance = await agents.send(
            sendCtx,
            held.agentId,
            { role: "user", content: [{ type: "text", text }] },
            {
                id,
                metadata: USER_MESSAGE_ORIGIN_METADATA,
                provider: mode.providerId,
                model: mode.modelId,
                effort: mode.effort as SessionReasoningEffort,
                permissionMode: mode.permissionMode,
            },
        );
        return acceptance.accepted;
    }

    // ---- tool policy ----------------------------------------------------------------------

    async #beforeToolCall(
        ctx: Context,
        scope: AgentModuleScope,
        call: AgentBaseToolCall,
    ): Promise<AgentBaseToolCallDecision | undefined> {
        const held = this.#byAgent(scope.agent.id);
        if (held === undefined) return await this.#unheld(ctx, scope.agent.id);
        const tool = call.tool.name;
        const inputSha256 = createHash("sha256").update(stableJson(call.arguments)).digest("hex");
        if (this.#deadlineReached(held)) {
            void this.#expireDeadline(held);
            return refusal("The bounded run deadline has passed. This action did not run.");
        }
        if (held.ending !== undefined || held.lost || held.stopRequested) {
            return refusal("This Orkest run has ended; the action did not run. Stop.");
        }
        if (held.declinedAt !== undefined) {
            return refusal(
                "A person already declined an action in this run; nothing else runs. Stop.",
            );
        }
        if (held.releaseProjectLock !== undefined && !held.releaseProjectLock.isHeld()) {
            held.lost = true;
            await this.#end(held, "failed", "project lock lost");
            return refusal("The assigned project lock was lost. This action did not run.");
        }
        const pathScope =
            held.project === undefined
                ? undefined
                : await projectPathsResolveInside(held.project.path, tool, call.arguments);
        const pathCandidates = pathScope?.paths.map((candidate) => {
            return relative(held.project!.path, candidate).replaceAll("\\", "/");
        });
        const writesProtectedPath =
            (tool === "Write" || tool === "Edit") &&
            pathCandidates?.some(projectPathIsProtected) === true;
        if (writesProtectedPath) {
            held.toolCalls.push({ tool, inputSha256, decision: "denied" });
            return refusal("Project control files cannot be changed by an AFK run.");
        }
        const explicitlyDenied =
            held.project !== undefined &&
            (projectRuleDecision(held.project.deniedRules, tool) ||
                pathCandidates?.some((candidate) =>
                    projectRuleDecision(held.project!.deniedRules, tool, candidate),
                ) === true ||
                held.project.deniedRules.some((rule) => {
                    if (!rule.startsWith(`${tool}(`)) return false;
                    const supportedPathRule = [
                        "Read",
                        "Glob",
                        "Grep",
                        "ReadMediaFile",
                        "read_file",
                        "list_dir",
                        "grep",
                        "Write",
                        "Edit",
                    ].includes(tool);
                    return (
                        !supportedPathRule ||
                        (pathScope?.inside === false && rule === `${tool}(//**)`)
                    );
                }));
        if (explicitlyDenied) {
            held.toolCalls.push({ tool, inputSha256, decision: "denied" });
            return refusal("The trusted project settings deny this action. It did not run.");
        }
        const allowlisted =
            held.project !== undefined &&
            projectRuleDecision(held.project.allowedRules, tool) &&
            pathScope?.inside === true;
        const allowedByPath =
            held.project !== undefined &&
            pathScope?.inside === true &&
            (pathCandidates?.length ?? 0) > 0 &&
            pathCandidates!.every((candidate) =>
                projectRuleDecision(held.project!.allowedRules, tool, candidate),
            );
        if (
            AFK_READ_ONLY_TOOLS.has(tool) &&
            (held.project === undefined || pathScope?.inside === true) &&
            (held.project === undefined || allowlisted || allowedByPath) &&
            afkReadStaysInside(tool, held.directory, call.arguments)
        ) {
            held.toolCalls.push({ tool, inputSha256, decision: "ran" });
            await this.#progress(held, `Running: ${tool}`);
            return { type: "run" };
        }
        const dangerousWrite =
            call.arguments !== null &&
            typeof call.arguments === "object" &&
            (call.arguments as Record<string, unknown>).dangerouslyDisableSandbox === true;
        if (
            (tool === "Write" || tool === "Edit") &&
            !dangerousWrite &&
            (allowlisted || allowedByPath)
        ) {
            held.toolCalls.push({ tool, inputSha256, decision: "ran" });
            await this.#progress(held, `Running: ${tool}`);
            return { type: "run" };
        }
        const client = this.#client;
        if (client === undefined)
            return refusal("The Orkest owner is not running; the action did not run.");
        const key = `${tool}:${inputSha256.slice(0, 32)}`;
        let summary = `Run ${tool}`;
        try {
            const described = call.tool.describeAutoPermissionAction?.(
                call.arguments as never,
                ctx,
            );
            if (typeof described === "string" && described.trim().length > 0)
                summary = described.slice(0, 500);
        } catch {
            // The plain summary stands.
        }
        let approval = await client.requestApproval(held.runId, held.fence, {
            key,
            tool,
            summary,
            reason: "An unattended Orkest run needs a person's approval for every action beyond reading files.",
            inputSha256,
            inputPreview: stableJson(call.arguments).slice(0, PREVIEW_LIMIT),
        });
        if (approval === undefined) {
            return refusal(
                "This Orkest run is no longer held by this worker; the action did not run. Stop.",
            );
        }
        if (approval.state === "pending") {
            await this.#progress(held, `Waiting for approval: ${tool}`, true);
            approval = await this.#awaitAnswer(ctx, client, held, key);
            if (approval === undefined) {
                return refusal(
                    "The run stopped before a person answered; the action did not run. Stop.",
                );
            }
        }
        held.approvals.set(key, {
            key,
            tool,
            state: approval.state,
            answeredBy: approval.answeredBy ?? null,
        });
        if (approval.state === "approved") {
            if (this.#deadlineReached(held)) {
                void this.#expireDeadline(held);
                return refusal("The bounded run deadline has passed. This action did not run.");
            }
            const approvedPathScope =
                held.project === undefined
                    ? undefined
                    : await projectPathsResolveInside(held.project.path, tool, call.arguments);
            const approvedPathCandidates = approvedPathScope?.paths.map((candidate) =>
                relative(held.project!.path, candidate).replaceAll("\\", "/"),
            );
            const deniedAfterApproval =
                held.project !== undefined &&
                (projectRuleDecision(held.project.deniedRules, tool) ||
                    approvedPathCandidates?.some((candidate) =>
                        projectRuleDecision(held.project!.deniedRules, tool, candidate),
                    ) === true ||
                    (approvedPathScope?.inside === false &&
                        held.project.deniedRules.some((rule) => rule.startsWith(`${tool}(`))));
            if (held.releaseProjectLock !== undefined && !held.releaseProjectLock.isHeld()) {
                held.lost = true;
                await this.#end(held, "failed", "project lock lost");
                return refusal("The assigned project lock was lost. This action did not run.");
            }
            if (
                this.#deadlineReached(held) ||
                (held.project !== undefined &&
                    (deniedAfterApproval ||
                        approvedPathScope?.inside !== true ||
                        (!["Write", "Edit"].includes(tool) && !AFK_READ_ONLY_TOOLS.has(tool)) ||
                        dangerousWrite ||
                        ((tool === "Write" || tool === "Edit") &&
                            approvedPathCandidates?.some(projectPathIsProtected) === true)))
            ) {
                held.toolCalls.push({ tool, inputSha256, decision: "denied" });
                await this.#progress(
                    held,
                    `Blocked outside the supported project scope: ${tool}`,
                    true,
                );
                return refusal(
                    "This approved action cannot be safely confined to the assigned project. It did not run.",
                );
            }
            held.toolCalls.push({ tool, inputSha256, decision: "approved" });
            await this.#progress(held, `Approved: ${tool}`, true);
            return { type: "run" };
        }
        held.toolCalls.push({ tool, inputSha256, decision: "denied" });
        // The model reads the refusal; the run ends declined once its loop settles.
        held.declinedAt = Date.now();
        await this.#progress(held, `Declined: ${tool}`, true);
        return refusal(
            "A person declined this action in Orkest, so it did not run. Do not retry it or work around it. Stop.",
        );
    }

    async #awaitAnswer(
        ctx: Context,
        client: OrkestAfkClient,
        held: HeldRun,
        key: string,
    ): Promise<AfkApproval | undefined> {
        const lifetime =
            ctx.lifetime === undefined
                ? this.#stop.signal
                : AbortSignal.any([ctx.lifetime, this.#stop.signal]);
        const waitCtx = withLifetime(ctx, lifetime);
        for (;;) {
            if (
                this.#deadlineReached(held) ||
                held.lost ||
                held.stopRequested ||
                held.ending !== undefined ||
                lifetime.aborted
            ) {
                return undefined;
            }
            await delay(waitCtx, APPROVAL_POLL_MS);
            if (
                this.#deadlineReached(held) ||
                held.lost ||
                held.stopRequested ||
                held.ending !== undefined
            )
                return undefined;
            let approval: AfkApproval | undefined;
            try {
                approval = await client.approval(held.runId, key);
            } catch (error) {
                if (isAbortedError(error) || lifetime.aborted) throw error;
                continue;
            }
            if (approval === undefined) return undefined;
            if (approval.state !== "pending") return approval;
        }
    }

    /** A call from an AFK task this worker does not hold (yet) never runs. */
    async #unheld(ctx: Context, agentId: string): Promise<AgentBaseToolCallDecision | undefined> {
        if (this.#status !== "running") return undefined;
        let task: TaskRecord | undefined;
        try {
            task = await this.#tasks.forAgent(ctx, agentId);
        } catch {
            return undefined;
        }
        if (task === undefined || !task.folderName.startsWith(AFK_FOLDER_PREFIX)) return undefined;
        return refusal("This Orkest run is not held by this worker; the action did not run. Stop.");
    }

    // ---- ending ---------------------------------------------------------------------------

    /** Receipt first, then completion. Idempotent per run; a failure is retried by a later call. */
    #end(held: HeldRun, outcome: Outcome, error?: string): Promise<void> {
        if (held.ending !== undefined) return held.ending;
        const ending = this.#finish(held, outcome, error).catch((failure: unknown) => {
            this.#lastError = failure instanceof Error ? failure.message : String(failure);
            // Leave the run held so the next tick can end it again.
            held.ending = undefined;
        });
        held.ending = ending;
        return ending;
    }

    async #finish(held: HeldRun, outcome: Outcome, error: string | undefined): Promise<void> {
        if (held.deadlineTimer !== undefined) clearTimeout(held.deadlineTimer);
        const client = this.#client;
        const ctx = this.#root;
        if (client === undefined || ctx === undefined) return;
        if (outcome === "declined" || outcome === "stopped") await this.#archive(ctx, held.taskId);
        await this.#progress(
            held,
            outcome === "proposed"
                ? "Finished; proposed for review"
                : outcome === "declined"
                  ? "Ended: a person declined an action"
                  : outcome === "stopped"
                    ? "Stopped by a person"
                    : "Failed",
            true,
        );
        if (!held.receiptPublished) {
            const published = await client.receipt(
                held.runId,
                held.fence,
                this.#receipt(held, outcome),
            );
            if (!published.ok && published.final) return this.#forget(ctx, held);
            held.receiptPublished = true;
        }
        const completion: AfkCompletion =
            outcome === "proposed"
                ? { kind: "proposed" }
                : outcome === "declined"
                  ? { kind: "declined", reason: "approval_denied" }
                  : outcome === "stopped"
                    ? { kind: "declined", reason: "stopped_by_person" }
                    : { kind: "failed", reason: (error ?? "failed").slice(0, 200) };
        await client.complete(held.runId, held.fence, completion);
        this.#held.delete(held.runId);
        await held.releaseProjectLock?.();
    }

    #receipt(held: HeldRun, outcome: Outcome): Record<string, unknown> {
        return {
            runId: held.runId,
            title: held.title,
            workLabel: held.workLabel,
            outcome,
            summary: (held.lastText || held.text).slice(0, SUMMARY_LIMIT),
            toolCalls: held.toolCalls.map((call) => ({ ...call })),
            approvals: [...held.approvals.values()].map((approval) => ({ ...approval })),
            turns: held.turns,
        };
    }

    async #drop(ctx: Context, held: HeldRun): Promise<void> {
        held.lost = true;
        await this.#archive(ctx, held.taskId);
        this.#held.delete(held.runId);
        await held.releaseProjectLock?.();
    }

    async #forget(ctx: Context, held: HeldRun): Promise<void> {
        await this.#drop(ctx, held);
    }

    async #archive(ctx: Context, taskId: string): Promise<void> {
        const task = await this.#tasks.get(ctx, taskId);
        if (task === undefined || task.status === "archived") return;
        await this.#tasks.archive(ctx, taskId, task.version);
    }

    // ---- observation ----------------------------------------------------------------------

    #observe(agentId: string, event: SessionEvent): void {
        const held = this.#byAgent(agentId);
        if (held === undefined) return;
        if (event.type === "text_start") held.text = "";
        else if (event.type === "text_delta")
            held.text = (held.text + event.delta).slice(-SUMMARY_LIMIT);
        else if (event.type === "text_end" && held.text.trim().length > 0)
            held.lastText = held.text;
    }

    /** One progress line; ordinary lines at most every five seconds. Never throws. */
    async #progress(held: HeldRun, text: string, always = false): Promise<void> {
        const client = this.#client;
        if (client === undefined) return;
        const now = Date.now();
        if (!always && now - held.lastProgress < PROGRESS_MS) return;
        held.lastProgress = now;
        try {
            const result = await client.progress(held.runId, held.fence, text);
            if (!result.ok && result.final) held.lost = true;
        } catch {
            // Progress is display-only.
        }
    }

    #byAgent(agentId: string): HeldRun | undefined {
        for (const held of this.#held.values()) if (held.agentId === agentId) return held;
        return undefined;
    }
}

const AFK_FOLDER_PREFIX = "orkest_afk_";

function refusal(text: string): AgentBaseToolCallDecision {
    return { type: "answer", content: [{ type: "text", text }], isError: true };
}

/** JSON with object keys sorted, so the same arguments always hash the same. */
export function stableJson(value: unknown): string {
    const stable = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(stable);
        if (item !== null && typeof item === "object") {
            const record = item as Record<string, unknown>;
            return Object.fromEntries(
                Object.keys(record)
                    .sort()
                    .map((key) => [key, stable(record[key])]),
            );
        }
        return item;
    };
    return JSON.stringify(stable(value)) ?? "null";
}

/** A stable Happy identity for one AFK run, salted apart from the attended owner's identities. */
export function afkDerivedId(kind: "t" | "w" | "a" | "m", seed: string): string {
    return `k${kind}${createHash("sha256").update(`orkest-afk:${kind}:${seed}`).digest("hex").slice(0, 24)}`;
}

/** The run's task folder name: recognisable as an AFK run, stable across restarts. */
export function afkFolderName(runId: string): string {
    return `${AFK_FOLDER_PREFIX}${createHash("sha256").update(`orkest-afk:f:${runId}`).digest("hex").slice(0, 24)}`;
}
