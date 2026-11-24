import { documentContract, documentOutline } from "../hoja/assist/index.mjs";

/**
 * GHO-196 — what a Happy project or doc session's agent is told, as its instructions (not a composer draft, so the
 * person's first message stays theirs and the contract holds on every turn).
 *
 * The document contract is Hoja's (`assist/contract.mjs`, the `tool` host: edit the working copy, call
 * `propose_document`, the app sends the whole file), shared with Botanic and the dashboard (D-25). The facts are the
 * session's: its project, its focus doc with revision and outline, and what it may and may never do (D-22, D-29).
 */
export interface ProjectSessionPreambleInput {
    readonly title: string;
    readonly scope: {
        readonly kind: "project" | "doc";
        readonly projectId: string;
        readonly path: string | null;
    };
    readonly permissionMode: string;
    /** The focus doc as read at open: the doc session's path, or the roadmap of a project session. */
    readonly focus?: { readonly path: string; readonly rev: string; readonly text: string };
    /** How many docs the project has; `null` when it has no repository Orkest can read. */
    readonly docs: number | null;
    /** Where the agent starts (GHO-204): the project's repository, or null for the empty project folder. */
    readonly workingDirectory?: { readonly repoPath: string | null; readonly taskPath: string };
}

export const SESSION_TOOL_NAMES = [
    "list_docs",
    "read_doc",
    "list_trackers",
    "read_tracker",
    "list_tickets",
    "read_ticket",
    "list_runs",
    "read_run",
    "propose_document",
] as const;

/** `docs/a/b.md` → `doc/a/b.md`: where its working copy is, relative to the task folder. */
export function workingCopyName(docPath: string): string {
    return `doc/${docPath.replace(/^docs\//, "")}`;
}

export function projectSessionPreamble(input: ProjectSessionPreambleInput): string {
    const { scope } = input;
    const readOnly = input.permissionMode !== "workspace_write";
    const lines: string[] = [];
    lines.push(
        scope.kind === "doc" && scope.path
            ? `You are an Orkest document session about ${scope.path} in the project "${input.title}" (project id ${scope.projectId}).`
            : `You are the Orkest project session of "${input.title}" (project id ${scope.projectId}): the main session a person talks to about this project, its plans, tickets, runs and docs.`,
    );
    lines.push(
        `Read Orkest through your tools (${SESSION_TOOL_NAMES.join(", ")}); never guess what a doc, ticket or run says. Every read is made as the person who opened this session and stays inside this project.`,
        "Status is never evidence: a ticket, tracker or roadmap node is done only with something a person can open (a commit, a receipt, a promoted tracker). You never approve, accept, merge, start runs or change settings; when something waits for the person, say what and why.",
    );
    if (input.docs === null) {
        lines.push(
            "This project has no docs yet: it has no repository Orkest can read, so the doc tools answer an empty list. Work from its tickets and runs (list_tickets, read_ticket, list_runs, read_run) and answer in the chat. When the person wants a plan written down, say that the project needs a repository first.",
        );
        return lines.join("\n\n");
    }
    if (input.docs === 0)
        lines.push(
            "This project has a repository but no docs yet. To start one, write it as a new working copy and call propose_document with its docs/ path; the person approves the new doc before it exists.",
        );
    lines.push(
        "read_doc(path) also writes that doc's working copy into your task folder (docs/<name>.md becomes doc/<name>.md), the only place you write. propose_document(path, why) sends that whole working copy; it changes nothing until the person accepts it on the Board. If it answers that the doc moved, the working copy now holds the current text: apply your change again and call it again.",
    );
    if (input.focus) {
        const reference = {
            path: input.focus.path,
            rev: input.focus.rev,
            outline: documentOutline(input.focus.text),
        };
        lines.push(
            `Focus doc: ${input.focus.path}, working copy ${workingCopyName(input.focus.path)} (already written). Reference data: ${JSON.stringify(reference)}`,
        );
    }
    if (readOnly) {
        lines.push(
            "This session is read only: you cannot write a working copy or call propose_document. Describe a change in prose and say that the session is read only.",
        );
        return lines.join("\n\n");
    }
    lines.push(
        documentContract({
            host: "tool",
            tool: "propose_document",
            workingCopy: input.focus ? workingCopyName(input.focus.path) : "doc/<file>.md",
            outline: input.focus !== undefined,
        }),
    );
    return lines.join("\n\n");
}
