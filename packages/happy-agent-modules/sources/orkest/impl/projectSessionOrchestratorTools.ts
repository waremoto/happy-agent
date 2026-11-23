import { Type } from "@sinclair/typebox";
import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";

import type {
    OrkestSessionAnswer,
    OrkestSessionCall,
    OrkestSessionClient,
} from "./OrkestSessionClient.js";

/**
 * GHO-199 — the project session as orchestrator (orkest docs/design/orkest-project-session.md section 3). A project
 * session's agent may see and ask; the person decides:
 *   - `start_run` and `propose_ticket` ask the person (a card they answer); nothing starts or is created until they
 *     approve, unless a project owner gave a standing allowance for unattended runs;
 *   - `stop_run` stops a run this session started; `list_children`, `list_requests`, `read_notes`, `ack_notes` and
 *     `reconcile_roadmap` read.
 * There is no tool to approve, reject or answer anything for the person, and the dashboard refuses every name for
 * one. A doc session gets none of these.
 */
export interface ProjectSessionOrchestratorInput {
    readonly client: OrkestSessionClient;
    readonly call: () => OrkestSessionCall;
    readonly permissionMode: string;
}

const MAX_TOOL_TEXT = 60_000;

export function projectSessionOrchestratorTools(
    input: ProjectSessionOrchestratorInput,
): readonly AnyAgentTool[] {
    const tool = (
        name: string,
        description: string,
        parameters: ReturnType<typeof Type.Object>,
        writes = false,
    ) =>
        defineAgentTool({
            name,
            // Nothing here acts for the person: an ask becomes their card, a stop is of this chat's own run.
            shouldReviewInAutoMode: () => false,
            description,
            parameters,
            returnType: Type.String(),
            execute: async (_ctx, args) =>
                writes && input.permissionMode !== "workspace_write"
                    ? "This session is read only: it cannot ask to start runs or create tickets. Suggest it in the chat instead."
                    : orchestratorTool(input, name, args as Record<string, unknown>),
            toLLM: (text) => [{ type: "text", text }],
        });
    return [
        tool(
            "start_run",
            "Ask the person to start work on one of this project's tickets: mode 'afk' (an unattended run) or 'attended' (a conversation; harness 'claude' or 'codex'). The person gets a card with your reason and approves or rejects it; nothing starts until they do. Give one short reason.",
            Type.Object({
                ticket: Type.String({ description: "The ticket identifier, for example ORKE-12" }),
                mode: Type.Union([Type.Literal("afk"), Type.Literal("attended")]),
                harness: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
                why: Type.String({ description: "One sentence: why this run, now" }),
            }),
            true,
        ),
        tool(
            "propose_ticket",
            "Ask the person to create a ticket in this project. They get a card and create it, or not; it is never created silently.",
            Type.Object({
                title: Type.String(),
                description: Type.Optional(Type.String()),
                priority: Type.Optional(
                    Type.Union([
                        Type.Literal("none"),
                        Type.Literal("urgent"),
                        Type.Literal("high"),
                        Type.Literal("medium"),
                        Type.Literal("low"),
                    ]),
                ),
                why: Type.String({ description: "One sentence: why this ticket" }),
            }),
            true,
        ),
        tool(
            "stop_run",
            "Stop a run this chat started (list_children lists them). A person's own Stop always wins; you cannot stop other runs.",
            Type.Object({ runId: Type.String() }),
            true,
        ),
        tool(
            "list_children",
            "List the runs this chat started, with their state, receipt and whether one waits on the person's approval.",
            Type.Object({}),
        ),
        tool(
            "list_requests",
            "List what you asked the person that is still waiting on their answer (runs, tickets, new docs). Only the person answers them.",
            Type.Object({}),
        ),
        tool(
            "read_notes",
            "Read the change notes due to this chat: runs it started that ended, are blocked or wait for approval. Acknowledge each with ack_notes once you have told the person.",
            Type.Object({}),
        ),
        tool(
            "ack_notes",
            "Mark one change note as told (the runId and state read_notes gave).",
            Type.Object({ runId: Type.String(), state: Type.String() }),
        ),
        tool(
            "reconcile_roadmap",
            "Compare docs/ROADMAP.md with the evidence its nodes' refs point at (tickets, trackers, receipts of the runs this chat started) and get the suggested status changes. Then propose them as one edit of the roadmap; a node goes to done only with its receipt or promoted tracker in its note.",
            Type.Object({ path: Type.Optional(Type.String()) }),
        ),
    ];
}

async function orchestratorTool(
    input: ProjectSessionOrchestratorInput,
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    let answer: OrkestSessionAnswer;
    try {
        answer = await input.client.tool(name, input.call(), args);
    } catch (error) {
        return `Orkest is unavailable right now (${error instanceof Error ? error.message : "error"}). Try again later.`;
    }
    if (!answer.ok) return refusal(answer);
    const body = (answer.body ?? {}) as Record<string, unknown>;
    if (name === "start_run" || name === "propose_ticket") {
        if (body.state === "started") {
            const a = (body.allowance ?? {}) as { used?: unknown; maxPerDay?: unknown };
            return `Started the unattended run on ${String(body.ticket)} (run ${String(body.runId)}) under the project's standing allowance (${String(a.used)} of ${String(a.maxPerDay)} today). Tell the person; you will get a note when it ends.`;
        }
        if (body.state === "held") {
            const refused =
                typeof body.refusedByAdmission === "string"
                    ? ` Orkest's admission refused starting it now (${body.refusedByAdmission}), so it waits for the person instead.`
                    : "";
            return `Asked the person: "${String(body.sentence ?? "")}". It waits on their card; nothing happens until they answer, and you cannot answer it.${refused} Tell them it is waiting.`;
        }
    }
    return clip(JSON.stringify(answer.body));
}

function refusal(answer: Exclude<OrkestSessionAnswer, { ok: true }>): string {
    switch (answer.error) {
        case "ORKEST_SESSION_CANNOT_ANSWER":
            return "Only the person answers approvals and requests. Tell them what is waiting and why.";
        case "ORKEST_SESSION_NOT_PROJECT":
            return "Only the project's main chat can start runs or create tickets; this chat is about one doc.";
        case "ORKEST_SESSION_READ_ONLY":
            return "This session is read only: it cannot ask to start runs or create tickets.";
        case "out_of_scope":
            return "That ticket belongs to another project; this chat only reaches its own project.";
        case "ORKEST_SESSION_NOT_A_CHILD":
            return "That run was not started by this chat, so it cannot stop it. The person can stop it from the Board.";
        case "ORKEST_SESSION_BAD_TICKET":
            return "That is not a ticket identifier of this project (for example ORKE-12), or the ticket's fields are not valid.";
        case "ORKEST_SESSION_BAD_MODE":
            return "mode must be 'afk' (unattended) or 'attended' (a conversation).";
        case "ORKEST_SESSION_BAD_HARNESS":
            return "harness must be 'claude' or 'codex'.";
        default:
            if (answer.status === 404) return `Not found (${answer.error}).`;
            return `Orkest refused this (${answer.status} ${answer.error}).`;
    }
}

function clip(text: string): string {
    return text.length > MAX_TOOL_TEXT
        ? `${text.slice(0, MAX_TOOL_TEXT)}\n[cut at ${MAX_TOOL_TEXT} characters]`
        : text;
}
