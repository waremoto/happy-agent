import type { AttendedSession } from "./OrkestAgencyClient.js";
import { contextSetOf, type ContextFile } from "./projectSessionContext.js";
import { mainDocOpenPath } from "./projectSessionMainDoc.js";
import type { OrkestSessionCall, OrkestSessionClient } from "./OrkestSessionClient.js";
import {
    baseFor,
    isDocPath,
    readWorkingCopy,
    writeWorkingCopy,
} from "./projectSessionWorkspace.js";

/** GHO-196 — what an open Happy project or doc session knows about itself. */
export interface ProjectSessionState {
    readonly scope: {
        readonly kind: "project" | "doc";
        readonly projectId: string;
        readonly path: string | null;
    };
    readonly title: string;
    readonly permissionMode: string;
    readonly taskPath: string;
    /** The repository the agent starts in (GHO-204); null when it starts in the empty project folder. */
    readonly repoPath: string | null;
    /** GHO-207.2.3 — the project's harness mode applies to this session. */
    harnessMode?: boolean;
    /** GHO-207.2.1 — the repository Father named that is not on this host. */
    missingRepoPath?: string;
    focus?: { readonly path: string; readonly rev: string; readonly text: string };
    /** Docs the project has; `null` when it has no repository Orkest can read. */
    docs: number | null;
    /** GHO-205.6.1 — the context set the dashboard sent at open (D-42). */
    context?: readonly ContextFile[];
}

export const ROADMAP_PATH = "docs/ROADMAP.md";

/** A project or doc session this Happy worker owns: a scope and backend `happy` (GHO-195). */
export function isProjectSession(session: AttendedSession): session is AttendedSession & {
    scope: NonNullable<AttendedSession["scope"]> & { kind: "project" | "doc" };
} {
    // GHO-204: a ticket session's scope only names its project; it is still opened as a work item.
    return (
        (session.scope?.kind === "project" || session.scope?.kind === "doc") &&
        (session.backend ?? "happy") === "happy"
    );
}

export function projectSessionState(
    session: AttendedSession & {
        scope: NonNullable<AttendedSession["scope"]> & { kind: "project" | "doc" };
    },
    taskPath: string,
    repoPath: string | null = null,
): ProjectSessionState {
    return {
        scope: {
            kind: session.scope.kind,
            projectId: session.scope.projectId,
            path: session.scope.path ?? null,
        },
        title: session.title,
        permissionMode: session.permissionMode,
        taskPath,
        repoPath,
        docs: null,
    };
}

/** The seam's answers that mean "this project has no docs": no repo, or a repo gitd does not index. */
const NO_REPO = /^(ORKEST_GIT_NO_REPO|ORKEST_GIT_REPO_NOT_INDEXED|no_repo)$/;

/**
 * Open the session's workspace: count the project's docs and write the focus doc's working copy (the doc session's
 * path, else the roadmap when it exists). A copy already on disk with its base (a worker restart) is kept, since
 * the agent may have edited it. Returns the error text for diagnostics, never throws for a refusal.
 */
export async function openProjectSession(
    client: OrkestSessionClient,
    call: OrkestSessionCall,
    state: ProjectSessionState,
): Promise<string | undefined> {
    const listed = await client.tool("list_docs", call, {});
    let paths: string[] = [];
    if (listed.ok) {
        const body = (listed.body ?? {}) as { docs?: unknown; repo?: unknown };
        paths = (Array.isArray(body.docs) ? body.docs : [])
            .map((d) => (d as { path?: unknown }).path)
            .filter((p): p is string => typeof p === "string");
        state.docs = body.repo === null ? null : paths.length;
    } else if (listed.status === 404 && NO_REPO.test(listed.error)) {
        state.docs = null;
        return undefined;
    } else {
        state.docs = null;
        return `list_docs answered ${listed.status} ${listed.error}`;
    }
    if (state.docs === null) return undefined;
    // GHO-205.3.2: the doc a project session opens on is the one the `focus` tool names (the person's choice, else
    // ROADMAP, README, CONTEXT); an older dashboard has no such tool and the same order applies here.
    // GHO-205.6.1: the same call asks for the context set (an older dashboard ignores `context`).
    const answer = await client.tool("focus", call, { context: true }).catch(() => null);
    const context = contextSetOf(answer);
    if (context) state.context = context;
    const focus =
        state.scope.kind === "doc" && state.scope.path
            ? state.scope.path
            : mainDocOpenPath(answer, paths);
    if (focus === undefined || !isDocPath(focus)) return undefined;
    const base = await baseFor(state.taskPath, focus);
    const copy = await readWorkingCopy(state.taskPath, focus);
    if (typeof base === "string" && copy !== undefined) {
        state.focus = { path: focus, rev: base, text: copy };
        return undefined;
    }
    const read = await client.tool("read_doc", call, { path: focus });
    if (!read.ok) return `read_doc answered ${read.status} ${read.error}`;
    const doc = (read.body ?? {}) as { text?: unknown; rev?: unknown };
    if (typeof doc.text !== "string" || typeof doc.rev !== "string") return "read_doc gave no text";
    await writeWorkingCopy(state.taskPath, focus, doc.text, doc.rev);
    state.focus = { path: focus, rev: doc.rev, text: doc.text };
    return undefined;
}
