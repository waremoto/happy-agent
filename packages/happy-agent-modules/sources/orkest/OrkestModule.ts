import { createHash } from "node:crypto";

import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { MessageMode } from "@slopus/happy-agent-client";
import { delay, detach, isAbortedError, withLifetime, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { TasksModule } from "../tasks/index.js";
import {
    OrkestAgencyClient,
    type AttendedSession,
    type OrkestAgencyEndpoint,
} from "./impl/OrkestAgencyClient.js";

/** How often the owner reads Orkest; a person who just clicked waits at most this long. */
const POLL_MS = 2_000;
/** The lease asked for at each claim and heartbeat, and how often it is renewed. */
const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;

/** The model each harness opens with; the person can change it in the composer before sending. */
const HARNESS_MODELS: Readonly<Record<string, string>> = {
    claude: "claude-code/sonnet",
    codex: "codex-cli/gpt-6.1-sol",
};

interface OpenSession {
    readonly runId: string;
    readonly taskId: string;
    readonly agentId: string;
    fence: number;
    lastHeartbeat: number;
}

/**
 * Happy as the attended owner of Orkest runs (ORKEST-AGENCY.4.1).
 *
 * A person starts an attended session on a work item in Orkest. Orkest admits a run and leaves a
 * dispatch intent; this module drains it: it opens a task whose conversation is drafted with the
 * work item, acknowledges the intent with that task, claims the run and keeps its lease. Nothing
 * runs until the person sends a message, so every turn is attended. When the person ends the
 * session in Orkest, the module archives the task (stopping any turn) and completes the run.
 * A run Orkest revokes, or a lease another worker took, closes the task the same way.
 *
 * Enabled only with `ORKEST_AGENCY_URL` and `ORKEST_AGENCY_TOKEN_FILE`, and only on an attended-only
 * installation: an Orkest-hosted Happy must start no work of its own.
 */
export class OrkestModule implements AgentModule {
    readonly name = "orkest";
    readonly #config: ConfigModule;
    readonly #tasks: TasksModule;
    readonly #open = new Map<string, OpenSession>();
    readonly #stop = new AbortController();
    #agents: AgentSystemRef | undefined;
    #loop: Promise<void> | undefined;
    #status: "disabled" | "refused" | "running" = "disabled";
    #lastError: string | null = null;

    constructor(config: ConfigModule, tasks: TasksModule) {
        this.#config = config;
        this.#tasks = tasks;
    }

    /** For diagnostics: whether the owner runs, how many sessions it holds and the last failure. */
    get status(): { state: string; sessions: number; lastError: string | null } {
        return { state: this.#status, sessions: this.#open.size, lastError: this.#lastError };
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            afterStart: () => {
                const endpoint = this.#config.orkestAgency;
                if (endpoint === undefined) return;
                if (this.#config.attendedOnly !== true) {
                    // An Orkest-hosted Happy that could start work itself would be a second scheduler.
                    this.#status = "refused";
                    this.#lastError = "Orkest sessions need [features] attended_only = true.";
                    return;
                }
                const root = withAgentDatabase(detach(ctx).named("orkest-owner"), ctx.db);
                const lifetime =
                    ctx.lifetime === undefined
                        ? this.#stop.signal
                        : AbortSignal.any([ctx.lifetime, this.#stop.signal]);
                this.#status = "running";
                this.#loop = this.#run(withLifetime(root, lifetime), endpoint);
            },
        };
    };

    async close(): Promise<void> {
        this.#stop.abort();
        await this.#loop?.catch(() => undefined);
    }

    async #run(ctx: Context, endpoint: OrkestAgencyEndpoint): Promise<void> {
        const agency = new OrkestAgencyClient(endpoint);
        while (!this.#stop.signal.aborted) {
            try {
                await this.#tick(ctx, agency, endpoint.workerId);
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

    async #tick(ctx: Context, agency: OrkestAgencyClient, workerId: string): Promise<void> {
        // Sessions this worker already owns, including after its own restart.
        for (const session of await agency.active(workerId)) {
            const open =
                this.#open.get(session.runId) ?? (await this.#resume(agency, session, workerId));
            if (open === undefined) continue;
            if (session.endRequestedAt !== null)
                await this.#finish(ctx, agency, open, "ended by a person");
        }
        for (const session of await agency.pending())
            await this.#start(ctx, agency, session, workerId);

        const now = Date.now();
        for (const open of this.#open.values()) {
            if (now - open.lastHeartbeat < HEARTBEAT_MS) continue;
            const result = await agency.heartbeat(open.runId, open.fence, LEASE_SECONDS);
            if (result.ok) open.lastHeartbeat = now;
            // Revoked, superseded or gone: this process no longer owns the run.
            else if (result.final) await this.#drop(ctx, open);
        }
    }

    async #start(
        ctx: Context,
        agency: OrkestAgencyClient,
        session: AttendedSession,
        workerId: string,
    ): Promise<void> {
        if (session.intentId === null) return;
        const modelId = HARNESS_MODELS[session.harness];
        if (modelId === undefined) return;
        const mode: MessageMode = {
            providerId: session.harness,
            modelId,
            effort: "medium",
            serviceTier: null,
            permissionMode: session.permissionMode,
        };
        // Identities derived from the run: a repeated delivery finds the same task.
        const task = await this.#tasks.create(ctx, {
            id: derivedId("t", session.runId),
            workspaceId: derivedId("w", session.runId),
            agentId: derivedId("a", session.runId),
            name: session.title.slice(0, 120),
            mode,
        });
        await this.#draft(ctx, task.agentId, mode, session);
        const ack = await agency.acknowledge(session.intentId, task.id);
        if (!ack.ok) {
            // Cancelled before it opened, or acknowledged as another task: nothing of ours runs.
            if (ack.final) await this.#archive(ctx, task.id);
            return;
        }
        const lease = await agency.claim(session.runId, workerId, LEASE_SECONDS);
        if (lease === undefined) {
            await this.#archive(ctx, task.id);
            return;
        }
        this.#open.set(session.runId, {
            runId: session.runId,
            taskId: task.id,
            agentId: task.agentId,
            fence: lease.fence,
            lastHeartbeat: Date.now(),
        });
        await agency.publish(session.runId, lease.fence, "attended.session_opened", {
            taskId: task.id,
            agentId: task.agentId,
            harness: session.harness,
            modelId,
            permissionMode: session.permissionMode,
        });
    }

    async #resume(
        agency: OrkestAgencyClient,
        session: AttendedSession,
        workerId: string,
    ): Promise<OpenSession | undefined> {
        if (session.ownerJobRef === null) return undefined;
        // A new attempt with a higher fence: the previous process's fence stops counting.
        const lease = await agency.claim(session.runId, workerId, LEASE_SECONDS);
        if (lease === undefined) return undefined;
        const open: OpenSession = {
            runId: session.runId,
            taskId: session.ownerJobRef,
            agentId: derivedId("a", session.runId),
            fence: lease.fence,
            lastHeartbeat: Date.now(),
        };
        this.#open.set(session.runId, open);
        return open;
    }

    async #finish(
        ctx: Context,
        agency: OrkestAgencyClient,
        open: OpenSession,
        reason: string,
    ): Promise<void> {
        await this.#archive(ctx, open.taskId);
        // One session consumed from the session budget, so usage is known.
        await agency.complete(open.runId, open.fence, reason);
        this.#open.delete(open.runId);
    }

    async #drop(ctx: Context, open: OpenSession): Promise<void> {
        await this.#archive(ctx, open.taskId);
        this.#open.delete(open.runId);
    }

    async #archive(ctx: Context, taskId: string): Promise<void> {
        const task = await this.#tasks.get(ctx, taskId);
        if (task === undefined || task.status === "archived") return;
        await this.#tasks.archive(ctx, taskId, task.version);
    }

    /** The composer opens with the work item, so the person's first message is theirs to send. */
    async #draft(
        ctx: Context,
        agentId: string,
        mode: MessageMode,
        session: AttendedSession,
    ): Promise<void> {
        const agents = this.#agents;
        if (agents === undefined) return;
        const config = await agents.config(ctx, agentId);
        if (config === undefined) return;
        const draft = config.metadata?.["draft"] as { text?: unknown } | undefined;
        if (typeof draft?.text === "string" && draft.text.length > 0) return;
        const heading = session.title.startsWith(session.workLabel)
            ? session.title
            : `${session.workLabel}: ${session.title}`;
        const text = [`Orkest work item ${heading}`, session.brief]
            .filter((part) => part.trim().length > 0)
            .join("\n\n")
            .slice(0, 100_000);
        const version =
            typeof config.metadata?.["version"] === "number" ? config.metadata["version"] + 1 : 1;
        const now = Date.now();
        await agents.updateMetadata(ctx, agentId, {
            draft: {
                effort: mode.effort,
                modelId: mode.modelId,
                permissionMode: mode.permissionMode,
                providerId: mode.providerId,
                serviceTier: mode.serviceTier,
                text,
            },
            draftUpdatedAt: now,
            updatedAt: now,
            version,
        });
    }
}

/** A stable Happy identity for one run: lowercase, starts with a letter, 26 characters. */
export function derivedId(kind: "t" | "w" | "a", runId: string): string {
    return `o${kind}${createHash("sha256").update(`orkest:${kind}:${runId}`).digest("hex").slice(0, 24)}`;
}
