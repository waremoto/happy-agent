import { Type } from "@sinclair/typebox";
import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { agentSessionIdFor } from "./agentSessionId.js";
import type {
    OrkestSessionAnswer,
    OrkestSessionCall,
    OrkestSessionClient,
} from "./OrkestSessionClient.js";
import { projectSessionOrchestratorTools } from "./projectSessionOrchestratorTools.js";
import { workingCopyName } from "./projectSessionPreamble.js";
import {
    baseFor,
    isDocPath,
    readWorkingCopy,
    refreshStale,
    writeWorkingCopy,
} from "./projectSessionWorkspace.js";

/**
 * GHO-196 — the tools a Happy project or doc session's agent gets: the eight reads of Orkest's session tools API
 * and `propose_document`. Every call goes through the dashboard with this worker's own token and the session's
 * fence, so Father decides each time whether the run is still this worker's and of this project.
 *
 * `propose_document` never takes the document from the model: it reads the working copy from disk and sends it
 * whole with the base it was made from (design § 2). Nothing it does writes the doc: the person accepts on the
 * Board (D-22). No tool here can approve, accept or merge anything (D-29). GHO-199: a project session also gets the
 * orchestrator tools (projectSessionOrchestratorTools.ts), which ask the person to start runs or create tickets.
 */
export interface ProjectSessionToolsInput {
    readonly client: OrkestSessionClient;
    /** The session call with the fence in force now (it changes when the worker reclaims the run). */
    readonly call: () => OrkestSessionCall;
    readonly taskPath: string;
    readonly taskId: string;
    readonly agentHome: string;
    readonly agentId: string;
    readonly permissionMode: string;
    /** The model in force for this agent, for the proposal's co-author. */
    readonly model: () => string | undefined;
    /** A stable id for the agent turn in progress (the seam allows one proposal per turn). */
    readonly turn: (ctx: Context) => Promise<string>;
    /** GHO-199 — a project session (not a doc session) gets the orchestrator tools. */
    readonly scopeKind?: "project" | "doc";
}

const MAX_TOOL_TEXT = 120_000;

export function projectSessionTools(input: ProjectSessionToolsInput): readonly AnyAgentTool[] {
    const read = (name: string, description: string, parameters: ReturnType<typeof Type.Object>) =>
        defineAgentTool({
            name,
            shouldReviewInAutoMode: () => false,
            description,
            parameters,
            returnType: Type.String(),
            execute: async (_ctx, args) => readTool(input, name, args as Record<string, unknown>),
            toLLM: (text) => [{ type: "text", text }],
        });
    const tools: AnyAgentTool[] = [
        read(
            "list_docs",
            "List this project's docs (docs/**/*.md): path, rev, whether a person is editing it on the Board, whether it is a tracker.",
            Type.Object({}),
        ),
        read(
            "read_doc",
            "Read one doc of this project at its current revision, and write its working copy into your task folder (docs/<name>.md becomes doc/<name>.md) to edit and propose.",
            Type.Object({ path: Type.String({ description: "The doc's path, docs/<name>.md" }) }),
        ),
        read("list_trackers", "List this project's trackers (docs/**/*.imp.md).", Type.Object({})),
        read(
            "read_tracker",
            "Read one tracker (docs/**/*.imp.md) with its checked and open boxes; also writes its working copy.",
            Type.Object({ path: Type.String() }),
        ),
        read(
            "list_tickets",
            "List this project's tickets with their status and assignee.",
            Type.Object({}),
        ),
        read(
            "read_ticket",
            "Read one ticket of this project by its identifier (for example ORKE-12).",
            Type.Object({ ticket: Type.String() }),
        ),
        read(
            "list_runs",
            "List the runs and sessions of this project and its tickets: state, owner, what blocks them.",
            Type.Object({}),
        ),
        read(
            "read_run",
            "Read one run of this project: its state, pending approval, result and receipt.",
            Type.Object({ runId: Type.String() }),
        ),
    ];
    tools.push(
        defineAgentTool({
            name: "propose_document",
            // It writes nothing: the whole working copy becomes a proposal a person accepts on the Board.
            shouldReviewInAutoMode: () => false,
            description:
                "Propose your working copy of a doc as its new version. Edit doc/<name>.md in your task folder first (read_doc writes it), keeping the whole document; then call this with the doc's path (docs/<name>.md) and one sentence saying what you changed and why. The app sends the whole file; a person reviews and accepts it on the Board. A path with no doc yet asks the person to approve a new doc. One proposal per turn.",
            parameters: Type.Object({
                path: Type.String({ description: "The doc's path, docs/<name>.md" }),
                why: Type.String({ description: "One sentence: what you changed and why" }),
            }),
            returnType: Type.String(),
            execute: async (ctx, args) => propose(ctx, input, args.path, args.why),
            toLLM: (text) => [{ type: "text", text }],
        }),
    );
    if (input.scopeKind === "project")
        tools.push(
            ...projectSessionOrchestratorTools({
                client: input.client,
                call: input.call,
                permissionMode: input.permissionMode,
            }),
        );
    return tools;
}

async function readTool(
    input: ProjectSessionToolsInput,
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
    if (
        (name === "read_doc" || name === "read_tracker") &&
        answer.body &&
        typeof answer.body === "object"
    ) {
        const doc = answer.body as { path?: unknown; text?: unknown; rev?: unknown };
        if (isDocPath(doc.path) && typeof doc.text === "string" && typeof doc.rev === "string") {
            await writeWorkingCopy(input.taskPath, doc.path, doc.text, doc.rev);
            return clip(
                `Working copy written: ${workingCopyName(doc.path)} (rev ${doc.rev}). Edit that file, then call propose_document.\n${JSON.stringify(answer.body)}`,
            );
        }
    }
    if (name === "list_docs" || name === "list_trackers") {
        const body = (answer.body ?? {}) as { docs?: unknown; trackers?: unknown; repo?: unknown };
        const list = name === "list_docs" ? body.docs : body.trackers;
        if (body.repo === null || (Array.isArray(list) && list.length === 0))
            return `This project has no ${name === "list_docs" ? "docs" : "trackers"} yet.\n${JSON.stringify(answer.body)}`;
    }
    return clip(JSON.stringify(answer.body));
}

async function propose(
    ctx: Context,
    input: ProjectSessionToolsInput,
    path: string,
    why: string,
): Promise<string> {
    if (input.permissionMode !== "workspace_write")
        return "This session is read only: it cannot propose changes. Describe the change in the chat instead.";
    if (!isDocPath(path)) return `${JSON.stringify(path)} is not a doc path. Use docs/<name>.md.`;
    const text = await readWorkingCopy(input.taskPath, path);
    if (text === undefined)
        return `There is no working copy ${workingCopyName(path)}. Call read_doc("${path}") first, or write that file for a new doc, then propose.`;
    const known = await baseFor(input.taskPath, path);
    const baseRev = typeof known === "string" ? known : null;
    const why1 = why.trim().slice(0, 500) || "Proposed from the project session.";
    const session = await agentSessionIdFor(input.agentHome, input.agentId).catch(() => undefined);
    const model = input.model();
    let answer: OrkestSessionAnswer;
    try {
        answer = await input.client.propose(input.call(), {
            path,
            baseRev,
            text,
            why: why1,
            turn: await input.turn(ctx),
            ...(model === undefined ? {} : { model: model.slice(0, 120) }),
            agentSessionId: session?.id ?? input.taskId,
        });
    } catch (error) {
        return `Orkest is unavailable right now (${error instanceof Error ? error.message : "error"}); nothing was proposed. Try again later.`;
    }
    if (answer.ok) {
        const body = (answer.body ?? {}) as { state?: unknown; changes?: unknown; large?: unknown };
        if (body.state === "held")
            return `${path} does not exist yet, so the person was asked to approve creating it. Nothing exists until they approve. Tell them it is waiting for their approval.`;
        if (body.state === "unchanged")
            return `Your working copy of ${path} is the same as the doc: nothing to propose.`;
        const changes = typeof body.changes === "number" ? body.changes : 0;
        return `Proposed ${changes} change${changes === 1 ? "" : "s"} to ${path}. They show on the Board as marks the person can accept by section or reject; nothing is written until they accept.${body.large === true ? " The change removes more than half of the text, so it is flagged as large." : ""}`;
    }
    if (answer.error === "stale_base") {
        const data = (answer.data ?? {}) as { rev?: unknown; text?: unknown };
        if (typeof data.rev === "string" && typeof data.text === "string") {
            await refreshStale(input.taskPath, path, data.rev, data.text);
            return `${path} moved since your working copy was made (someone changed it). ${workingCopyName(path)} now holds the current text (rev ${data.rev}); your version is kept in doc/.stale/. Apply your change again to ${workingCopyName(path)} and call propose_document again.`;
        }
    }
    return refusal(answer);
}

function refusal(answer: Exclude<OrkestSessionAnswer, { ok: true }>): string {
    switch (answer.error) {
        case "already_proposed_this_turn":
            return "This turn already made a proposal; one proposal per turn. Say what you proposed and wait for the person.";
        case "doc_being_edited":
            return "A person is typing in this doc on the Board right now. Wait for them to finish, then read it again and propose.";
        case "ORKEST_SESSION_READ_ONLY":
            return "This session is read only: it cannot propose changes.";
        case "ORKEST_SESSION_PROPOSAL_TOO_LARGE":
            return "The document is over 60 000 characters, which a proposal cannot carry. Say so to the person.";
        case "out_of_scope":
            return "That belongs to another project; this session only reaches its own project.";
        case "doc_not_found":
            return "There is no such doc in this project.";
        case "done_without_evidence": {
            const nodes = (answer.data as { nodes?: unknown } | undefined)?.nodes;
            return `Nothing was proposed: a roadmap node goes to done only when its note names a receipt or run id, or a promoted tracker under docs/orkest/done/ (${Array.isArray(nodes) ? nodes.join(", ") : "a node"} has none). Add the evidence to its note, or leave it as it was, and propose again.`;
        }
        case "roadmap_invalid": {
            const errors = (answer.data as { errors?: unknown } | undefined)?.errors;
            return `Nothing was proposed: the roadmap would fail its check.\n${Array.isArray(errors) ? errors.map((e) => `- ${String(e)}`).join("\n") : ""}\nFix the roadmap block in your working copy and propose again (the rendered section below it is regenerated for you).`;
        }
        case "ORKEST_GIT_NO_REPO":
        case "ORKEST_GIT_REPO_NOT_INDEXED":
            return "This project has no docs yet: it has no repository Orkest can read.";
        default:
            if (answer.status === 413)
                return "The document is over 60 000 characters, which a proposal cannot carry. Say so to the person.";
            if (answer.status === 409)
                return `Orkest refused: this session is no longer live (${answer.error}). Tell the person to reopen the session.`;
            return `Orkest refused this (${answer.status} ${answer.error}).`;
    }
}

function clip(text: string): string {
    return text.length > MAX_TOOL_TEXT
        ? `${text.slice(0, MAX_TOOL_TEXT)}\n[cut at ${MAX_TOOL_TEXT} characters]`
        : text;
}
