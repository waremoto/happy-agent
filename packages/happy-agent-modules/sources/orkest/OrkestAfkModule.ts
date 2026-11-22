import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
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
    type AfkCompletion,
    type AfkRun,
    type OrkestAfkEndpoint,
} from "./impl/OrkestAfkClient.js";

/** How often the owner reads Orkest, and how often a waiting call re-reads its approval. */
const POLL_MS = 2_000;
/** The lease asked for at each claim and heartbeat, and how often it is renewed. */
const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;
/** Ordinary progress lines are rate-limited; start, approval and end lines always go out. */
const PROGRESS_MS = 5_000;
/** A declined run whose model keeps going is ended anyway after this long. */
const DECLINE_GRACE_MS = 60_000;
const SUMMARY_LIMIT = 4_000;

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
 * Enabled only with `ORKEST_AFK_URL`, `ORKEST_AFK_TOKEN_FILE`, `ORKEST_AFK_WORKER_TOKEN_FILE` and
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
            [...this.#held.values()].map((held) => held.ending?.catch(() => undefined)),
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
                this.#lastError = null;
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
        // Runs this worker already holds, including after its own restart.
        for (const run of await client.active()) {
            if (this.#stop.signal.aborted) return;
            const held =
                this.#held.get(run.runId) ??
                (await this.#reclaim(ctx, client, endpoint, mode, run));
            if (held === undefined || held.ending !== undefined) continue;
        }
        for (const run of await client.pending()) {
            if (this.#stop.signal.aborted) return;
            if (run.intentId === null || this.#held.has(run.runId)) continue;
            await this.#start(ctx, client, endpoint, mode, run, run.intentId);
        }
        const now = Date.now();
        for (const held of this.#held.values()) {
            if (held.ending !== undefined) continue;
            if (held.declinedAt !== undefined && now - held.declinedAt > DECLINE_GRACE_MS) {
                await this.#end(held, "declined");
                continue;
            }
            if (now - held.lastHeartbeat < HEARTBEAT_MS) continue;
            const result = await client.heartbeat(held.runId, held.fence, LEASE_SECONDS);
            if (result.ok) held.lastHeartbeat = now;
            // Revoked, superseded or gone: this process no longer owns the run.
            else if (result.final) await this.#drop(ctx, held);
        }
    }

    async #start(
        ctx: Context,
        client: OrkestAfkClient,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
        run: AfkRun,
        intentId: string,
    ): Promise<void> {
        const task = await this.#task(ctx, endpoint, mode, run);
        const ack = await client.acknowledge(intentId, task.id);
        if (!ack.ok) {
            // Cancelled before it opened, or acknowledged as another task: nothing of ours runs.
            if (ack.final) await this.#archive(ctx, task.id);
            return;
        }
        const lease = await client.claim(run.runId, LEASE_SECONDS);
        if (lease === undefined) {
            await this.#archive(ctx, task.id);
            return;
        }
        const held = this.#hold(run, task, lease.fence);
        await this.#sendBrief(ctx, held, mode, run);
        await this.#progress(held, "Started", true);
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
        const lease = await client.claim(run.runId, LEASE_SECONDS);
        if (lease === undefined) return undefined;
        const task = await this.#task(ctx, endpoint, mode, run);
        const held = this.#hold(run, task, lease.fence);
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
    }

    #hold(run: AfkRun, task: TaskRecord, fence: number): HeldRun {
        const held: HeldRun = {
            runId: run.runId,
            title: run.title,
            workLabel: run.workLabel,
            taskId: task.id,
            agentId: task.agentId,
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
        };
        this.#held.set(run.runId, held);
        return held;
    }

    /** The run's task, created once: identities derived from the run make a repeat find it. */
    async #task(
        ctx: Context,
        endpoint: OrkestAfkEndpoint,
        mode: MessageMode,
        run: AfkRun,
    ): Promise<TaskRecord> {
        const task = await this.#tasks.create(ctx, {
            id: afkDerivedId("t", run.runId),
            workspaceId: afkDerivedId("w", run.runId),
            agentId: afkDerivedId("a", run.runId),
            name: run.title.slice(0, 120),
            folderName: afkFolderName(run.runId),
            mode,
        });
        await this.#prepareWorkDirectory(endpoint, task);
        return task;
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
            "You are working unattended in this task's folder. Reading files runs directly; every other action waits for a person to approve it in Orkest, and a declined action must not be retried or worked around. When you are done, reply with a short summary of what you changed.",
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
        const acceptance = await agents.send(
            ctx,
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
