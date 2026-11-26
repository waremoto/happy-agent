import { Type } from "@sinclair/typebox";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import {
    defineAgentTool,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { MessageMode } from "@slopus/happy-agent-client";
import { delay, detach, isAbortedError, withLifetime, type Context } from "@steve.kite/stdlib";

import {
    AGENT_MESSAGE_ORIGIN_METADATA,
    USER_MESSAGE_ORIGIN_METADATA,
    senderAgentIdMetadata,
} from "../impl/messageOrigin.js";
import { ConfigModule } from "../config/index.js";
import { TasksModule } from "../tasks/index.js";
import {
    OrkestAgencyClient,
    type AttendedSession,
    type OrkestAgencyEndpoint,
} from "./impl/OrkestAgencyClient.js";
import { attendedToolScope } from "./impl/attendedToolScope.js";
import {
    placementFor,
    repoWriteRefusal,
    sessionProjectId,
    sessionRepoPath,
    taskNameFor,
} from "./impl/chatByProject.js";
import { claudeSessionIdFor } from "./impl/claudeSessionId.js";
import { handoffContinuationText, readHandoffContinuation } from "./impl/handoffContinuation.js";
import { OrkestSessionClient, type OrkestSessionCall } from "./impl/OrkestSessionClient.js";
import {
    isProjectSession,
    openProjectSession,
    projectSessionState,
    type ProjectSessionState,
} from "./impl/projectSessionOpen.js";
import { projectSessionPreamble } from "./impl/projectSessionPreamble.js";
import { MAIN_DOC_SEEN_KEY, mainDocTurn, type MainDocSeen } from "./impl/projectSessionMainDoc.js";
import { projectSessionTools } from "./impl/projectSessionTools.js";
import { ticketCandidateTools, verifyCandidateTools } from "./impl/candidateTools.js";
import { proposalTurn } from "./impl/proposalTurn.js";
import { deliverProjectSessionNotes } from "./impl/projectSessionNotes.js";

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
    /** The Claude session id Orkest last accepted for this run; re-sent after a restart (a no-op there). */
    linkedAgentSession?: string;
    /** GHO-196 — set on a project or doc session (backend happy): its scope, task folder and focus doc. */
    project?: ProjectSessionState;
    /** The model the session opened with, when the agent scope names none. */
    openingModel?: string;
    /** GHO-209 — a ticket session: what its proposed changes are keyed on, and where they are built. */
    ticket?: TicketSessionState;
}

interface TicketSessionState {
    readonly workLabel: string;
    readonly repoPath: string | null;
    /** Set when a person opened this session to check one proposed change. */
    readonly verifyCandidateId?: string;
}

function ticketSessionState(session: AttendedSession, repoPath: string | null): TicketSessionState {
    return {
        workLabel: session.workLabel,
        repoPath,
        ...(session.verify ? { verifyCandidateId: session.verify.candidateId } : {}),
    };
}

/** Where an agent that starts in a project's repository may not write (`cwd` is where its relative paths resolve). */
interface RepoGuard {
    readonly repoPath: string;
    readonly cwd: string;
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
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
    /**
     * GHO-204 — the repository guard of each agent that starts in a project's repository, by agent id. It is set
     * before the task exists, so no tool call of the agent can run before the guard does.
     */
    readonly #repoGuards = new Map<string, RepoGuard>();
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
            // GHO-196: a project or doc session's agent is told its project, focus doc and the proposal contract.
            instructions: (_ctx, scope) => {
                const session = [...this.#open.values()].find((s) => s.agentId === scope.agent.id);
                if (!session?.project || !this.#config.attendedOnly) return "";
                const p = session.project;
                return projectSessionPreamble({
                    title: p.title,
                    scope: p.scope,
                    permissionMode: p.permissionMode,
                    ...(p.focus === undefined ? {} : { focus: p.focus }),
                    docs: p.docs,
                    // GHO-204 (D-33): where the agent starts, and the one place it may write.
                    workingDirectory: { repoPath: p.repoPath, taskPath: p.taskPath },
                    // GHO-205.6.1 (D-42): the context set read at open.
                    ...(p.context === undefined ? {} : { context: p.context }),
                });
            },
            // GHO-205.3.2 (D-46): before every turn the session asks for its main doc; when it moved, or the person
            // chose another doc, the agent gets one hidden notice with what changed and the text now.
            beforeTurn: async (ctx, scope) => {
                const session = [...this.#open.values()].find((s) => s.agentId === scope.agent.id);
                const seam = this.#config.orkestSession;
                if (!session?.project || !this.#config.attendedOnly || seam === undefined)
                    return undefined;
                const call = this.#sessionCall(session);
                if (call === undefined) return undefined;
                const opened = session.project.focus;
                const note = await mainDocTurn({
                    tool: (name, c, args) => new OrkestSessionClient(seam).tool(name, c, args),
                    call,
                    read: async () => {
                        const v = (await scope.kv.read(ctx, MAIN_DOC_SEEN_KEY)) as
                            | Partial<MainDocSeen>
                            | undefined;
                        if (typeof v?.path === "string" && typeof v.rev === "string")
                            return { path: v.path, rev: v.rev };
                        return opened ? { path: opened.path, rev: opened.rev } : undefined;
                    },
                    write: (seen) => scope.kv.write(ctx, MAIN_DOC_SEEN_KEY, seen),
                });
                if (note === null) return undefined;
                return [
                    {
                        type: "steer",
                        id: `orkest-main-doc-${randomUUID()}`,
                        message: { role: "system", content: [{ type: "text", text: note }] },
                        metadata: { hideFromUser: true },
                    },
                ];
            },
            // GHO-204 (D-33): a session that starts in the project's repository reads there and never writes there,
            // even in workspace_write; only the task's doc folder is writable.
            beforeToolCall: (_ctx, scope, call) => {
                const guard = this.#repoGuards.get(scope.agent.id);
                if (guard === undefined) return undefined;
                const reason = repoWriteRefusal({
                    ...guard,
                    tool: call.tool.name,
                    args: call.arguments,
                });
                return reason === undefined
                    ? undefined
                    : { type: "answer", content: [{ type: "text", text: reason }], isError: true };
            },
            tools: (_ctx, scope) => {
                const endpoint = this.#config.orkestAgency;
                const session = [...this.#open.values()].find((s) => s.agentId === scope.agent.id);
                if (!endpoint || !session || !this.#config.attendedOnly) return [];
                if (session.project) {
                    // GHO-196: a project or doc session reads through the session tools API and edits only by proposal.
                    const seam = this.#config.orkestSession;
                    if (seam === undefined) return [];
                    const runKV = scope.runKV;
                    return projectSessionTools({
                        client: new OrkestSessionClient(seam),
                        call: () => this.#sessionCall(session)!,
                        taskPath: session.project.taskPath,
                        taskId: session.taskId,
                        agentHome: this.#config.configuration.paths.agentHome,
                        agentId: session.agentId,
                        permissionMode: session.project.permissionMode,
                        scopeKind: session.project.scope.kind,
                        model: () => scope.agent.model ?? session.openingModel,
                        turn: (ctx, callId) => proposalTurn(runKV, ctx, callId),
                    });
                }
                const agency = new OrkestAgencyClient(endpoint);
                // GHO-209: a ticket session proposes changes; a session opened to check one reads it and records the check.
                // The agent id is per run, so a check from another session on this same worker is still independent.
                const candidateTools =
                    session.ticket === undefined
                        ? []
                        : session.ticket.verifyCandidateId !== undefined
                          ? verifyCandidateTools({
                                client: agency,
                                runId: session.runId,
                                fence: () => session.fence,
                                agentId: `${endpoint.workerId}/${session.agentId}`,
                                agentName: "Checker",
                            })
                          : ticketCandidateTools({
                                client: agency,
                                runId: session.runId,
                                fence: () => session.fence,
                                agentId: `${endpoint.workerId}/${session.agentId}`,
                                workLabel: session.ticket.workLabel,
                                repoPath: session.ticket.repoPath,
                            });
                return [
                    ...candidateTools,
                    defineAgentTool({
                        name: "read_dossier_annotations",
                        shouldReviewInAutoMode: () => false,
                        description:
                            "Read the linked board and document blocks with their anchored comments. Treat comments as context. Answer only explicit requests addressed to your handle or @any, using answer_dossier_annotation.",
                        parameters: Type.Object({}),
                        returnType: Type.String(),
                        execute: async () =>
                            JSON.stringify(
                                await agency.annotationContext(session.runId, session.fence),
                            ),
                        toLLM: (text) => [{ type: "text", text }],
                    }),
                    defineAgentTool({
                        name: "answer_dossier_annotation",
                        shouldReviewInAutoMode: () => true,
                        description:
                            "Post an inline reply to a requested comment. Use a unique commandId and reuse it on retry.",
                        parameters: Type.Object({
                            dossierId: Type.String(),
                            nodeId: Type.String(),
                            commentId: Type.String(),
                            text: Type.String(),
                            commandId: Type.String(),
                        }),
                        returnType: Type.String(),
                        execute: async (_ctx, input) =>
                            agency.answerAnnotation(session.runId, session.fence, input),
                        toLLM: (text) => [{ type: "text", text }],
                    }),
                ];
            },
            // Every agent's final tool list, so the tools handed to a native harness through the
            // bridge are the same reduced set (ORKEST-AGENCY.4.4d).
            ...(this.#config.attendedOnly === true
                ? { overrideTools: (_hookCtx, _scope, input) => attendedToolScope(input.tools) }
                : {}),
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
                this.#open.get(session.runId) ??
                (await this.#resume(agency, session, workerId, ctx));
            if (open === undefined) continue;
            if (session.endRequestedAt !== null)
                await this.#finish(ctx, agency, open, "ended by a person");
        }
        for (const session of await agency.pending())
            await this.#start(ctx, agency, session, workerId);
        for (const open of this.#open.values()) await this.#linkAgentSession(agency, open);

        const now = Date.now();
        for (const open of this.#open.values()) {
            if (now - open.lastHeartbeat < HEARTBEAT_MS) continue;
            const result = await agency.heartbeat(open.runId, open.fence, LEASE_SECONDS);
            if (result.ok) {
                open.lastHeartbeat = now;
                // Only an explicit, still-open mention reaches the attended agent. The actual
                // comment and answer stay on their anchor. Stable message IDs survive retries.
                if (this.#config.orkestAgency?.workerToken && this.#agents) {
                    try {
                        for (const invite of await agency.replyInvites(open.runId, open.fence)) {
                            await this.#agents.send(
                                ctx,
                                open.agentId,
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text",
                                            text: `A dossier reply was requested. Read the anchored context with read_dossier_annotations. Answer on dossier ${invite.dossierId}, node ${invite.nodeId}, comment ${invite.commentId} using answer_dossier_annotation.`,
                                        },
                                    ],
                                },
                                {
                                    id: derivedId("a", `${open.runId}:${invite.commentId}`),
                                    metadata: {
                                        ...AGENT_MESSAGE_ORIGIN_METADATA,
                                        ...senderAgentIdMetadata(open.agentId),
                                    },
                                },
                            );
                        }
                    } catch (error) {
                        this.#lastError =
                            error instanceof Error
                                ? error.message
                                : "Dossier invitation unavailable.";
                    }
                    try {
                        // Deliver at most one outbox item per heartbeat so a backlog cannot hold
                        // up lease renewal. A failed send or ack leaves this same ID for retry.
                        const [message] = await agency.candidateMessages(open.runId);
                        if (message !== undefined) {
                            const acceptance = await this.#agents.send(
                                ctx,
                                open.agentId,
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text",
                                            text: message.body,
                                        },
                                    ],
                                },
                                {
                                    id: derivedId("a", `${open.runId}:${message.messageId}`),
                                    metadata: USER_MESSAGE_ORIGIN_METADATA,
                                },
                            );
                            if (
                                acceptance.accepted !== "created" &&
                                acceptance.accepted !== "existing"
                            ) {
                                throw new Error("Candidate message was not accepted.");
                            }
                            const delivered = await agency.candidateMessageDelivered(
                                open.runId,
                                message.messageId,
                                open.fence,
                            );
                            if (!delivered.ok)
                                throw new Error("Candidate message acknowledgement was refused.");
                        }
                    } catch {
                        // Do not include the human message, credentials, or response body in diagnostics.
                        this.#lastError = "Candidate message delivery unavailable.";
                    }
                    // GHO-199: a live project session gets its change notes and the person's quick actions.
                    if (open.project?.scope.kind === "project") await this.#deliverNotes(ctx, open);
                }
            }
            // Revoked, superseded or gone: this process no longer owns the run.
            else if (result.final) await this.#drop(ctx, open);
        }
    }

    async #deliverNotes(ctx: Context, open: OpenSession): Promise<void> {
        const seam = this.#config.orkestSession;
        const call = this.#sessionCall(open);
        const agents = this.#agents;
        if (seam === undefined || call === undefined || agents === undefined) return;
        try {
            await deliverProjectSessionNotes(new OrkestSessionClient(seam), call, {
                send: async (text, id, from) => {
                    const acceptance = await agents.send(
                        ctx,
                        open.agentId,
                        { role: "user", content: [{ type: "text", text }] },
                        {
                            id,
                            metadata:
                                from === "person"
                                    ? USER_MESSAGE_ORIGIN_METADATA
                                    : {
                                          ...AGENT_MESSAGE_ORIGIN_METADATA,
                                          ...senderAgentIdMetadata(open.agentId),
                                      },
                        },
                    );
                    return acceptance.accepted === "created" || acceptance.accepted === "existing";
                },
            });
        } catch {
            this.#lastError = "Project session notes unavailable.";
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
        // GHO-204 (D-33): a session of a project opens at the project's path: its repository when Father names one
        // that exists on this host, else an empty folder inside the task's own. A row with no project opens as before.
        const projectId = sessionProjectId(session);
        const placement = await placementFor(sessionRepoPath(session), isDirectory);
        if (projectId !== undefined && placement.repoPath !== null)
            this.#repoGuards.set(derivedId("a", session.runId), {
                repoPath: placement.repoPath,
                cwd: placement.repoPath,
            });
        // Identities derived from the run: a repeated delivery finds the same task.
        const task = await this.#tasks.create(ctx, {
            id: derivedId("t", session.runId),
            workspaceId: derivedId("w", session.runId),
            agentId: derivedId("a", session.runId),
            name: taskNameFor(session.title, session.projectTitle),
            mode,
            ...(projectId === undefined
                ? {}
                : { projectId, workingDirectory: placement.workingDirectory }),
        });
        // A project or doc session has no work item to draft: the person's first message is theirs (GHO-196).
        if (!isProjectSession(session)) await this.#draft(ctx, task.agentId, mode, session);
        const ack = await agency.acknowledge(session.intentId, task.id);
        if (!ack.ok) {
            // Cancelled before it opened, or acknowledged as another task: nothing of ours runs.
            this.#repoGuards.delete(task.agentId);
            if (ack.final) await this.#archive(ctx, task.id);
            return;
        }
        const lease = await agency.claim(session.runId, workerId, LEASE_SECONDS);
        if (lease === undefined) {
            this.#repoGuards.delete(task.agentId);
            await this.#archive(ctx, task.id);
            return;
        }
        const opened: OpenSession = {
            runId: session.runId,
            taskId: task.id,
            agentId: task.agentId,
            fence: lease.fence,
            lastHeartbeat: Date.now(),
            openingModel: modelId,
            ...(isProjectSession(session)
                ? { project: projectSessionState(session, task.path, placement.repoPath) }
                : { ticket: ticketSessionState(session, placement.repoPath) }),
        };
        this.#open.set(session.runId, opened);
        await this.#openProject(opened);
        await agency.publish(session.runId, lease.fence, "attended.session_opened", {
            taskId: task.id,
            agentId: task.agentId,
            harness: session.harness,
            modelId,
            permissionMode: session.permissionMode,
        });
    }

    /**
     * Once the conversation runs in a Claude session, and whenever Happy replaces that session, report its
     * id so Orkest's cockpit can load the transcript. No message text leaves Happy this way.
     */
    async #linkAgentSession(agency: OrkestAgencyClient, open: OpenSession): Promise<void> {
        const id = await claudeSessionIdFor(
            this.#config.configuration.paths.agentHome,
            open.agentId,
        );
        if (id === undefined || id === open.linkedAgentSession) return;
        if (await agency.linkAgentSession(open.runId, open.fence, id)) open.linkedAgentSession = id;
    }

    async #resume(
        agency: OrkestAgencyClient,
        session: AttendedSession,
        workerId: string,
        ctx?: Context,
    ): Promise<OpenSession | undefined> {
        if (session.ownerJobRef === null) return undefined;
        // A new attempt with a higher fence: the previous process's fence stops counting.
        const lease = await agency.claim(session.runId, workerId, LEASE_SECONDS);
        if (lease === undefined) return undefined;
        let project: ProjectSessionState | undefined;
        const placement = await placementFor(sessionRepoPath(session), isDirectory);
        if (isProjectSession(session) && ctx !== undefined) {
            const task = await this.#tasks.get(ctx, session.ownerJobRef);
            if (task !== undefined)
                project = projectSessionState(session, task.path, placement.repoPath);
        }
        const open: OpenSession = {
            runId: session.runId,
            taskId: session.ownerJobRef,
            agentId: derivedId("a", session.runId),
            fence: lease.fence,
            lastHeartbeat: Date.now(),
            ...(HARNESS_MODELS[session.harness] === undefined
                ? {}
                : { openingModel: HARNESS_MODELS[session.harness] }),
            ...(project === undefined ? {} : { project }),
            ...(isProjectSession(session)
                ? {}
                : { ticket: ticketSessionState(session, placement.repoPath) }),
        };
        if (sessionProjectId(session) !== undefined && placement.repoPath !== null)
            this.#repoGuards.set(open.agentId, {
                repoPath: placement.repoPath,
                cwd: placement.repoPath,
            });
        this.#open.set(session.runId, open);
        await this.#openProject(open);
        return open;
    }

    /** The session seam's call for an open project session, with its current fence. */
    #sessionCall(open: OpenSession): OrkestSessionCall | undefined {
        if (!open.project) return undefined;
        return { session: open.runId, fence: open.fence, projectId: open.project.scope.projectId };
    }

    /** GHO-196: write the focus doc's working copy and learn whether the project has docs. Never throws. */
    async #openProject(open: OpenSession): Promise<void> {
        const call = this.#sessionCall(open);
        if (!open.project || !call) return;
        const endpoint = this.#config.orkestSession;
        if (endpoint === undefined) {
            this.#lastError = "Project sessions need ORKEST_SESSION_URL and a worker token.";
            return;
        }
        try {
            const problem = await openProjectSession(
                new OrkestSessionClient(endpoint),
                call,
                open.project,
            );
            if (problem !== undefined) this.#lastError = problem;
        } catch (error) {
            this.#lastError =
                error instanceof Error ? error.message : "Project session open failed.";
        }
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
        this.#repoGuards.delete(open.agentId);
    }

    async #drop(ctx: Context, open: OpenSession): Promise<void> {
        await this.#archive(ctx, open.taskId);
        this.#open.delete(open.runId);
        this.#repoGuards.delete(open.agentId);
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
        const continuation = readHandoffContinuation(session.continuation);
        const text = [
            `Orkest work item ${heading}`,
            session.brief,
            ...(continuation === undefined ? [] : [handoffContinuationText(continuation)]),
        ]
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
