import type { AttendedSession } from "./OrkestAgencyClient.js";

/**
 * GHO-204 (ORKEST-CHAT-BY-PROJECT, D-33) — every session belongs to a project and opens at its path.
 *
 * RED stub: the names exist so the tests compile; each answers the wrong thing until the green commit.
 */

/** Where a session's agent starts: the project's repository, or an empty `project` folder inside its task folder. */
export interface SessionPlacement {
    /** An absolute directory, or a path relative to the task folder (created empty). */
    readonly workingDirectory: string;
    /** The repository the agent starts in; null when it starts in the empty folder. */
    readonly repoPath: string | null;
}

export async function placementFor(
    _repoPath: string | null | undefined,
    _exists: (path: string) => Promise<boolean>,
): Promise<SessionPlacement> {
    return { workingDirectory: "project", repoPath: null };
}

/** The task's display name: `[Project] name` when the project's title is known. */
export function taskNameFor(title: string, _projectTitle?: string | null): string {
    return title;
}

export function sessionProjectId(_session: AttendedSession): string | undefined {
    return undefined;
}

export function sessionRepoPath(_session: AttendedSession): string | undefined {
    return undefined;
}

export interface RepoWriteCall {
    readonly repoPath: string;
    /** The agent's working directory, which relative paths and commands resolve against. */
    readonly cwd: string;
    readonly tool: string;
    readonly args: unknown;
}

/** Why a tool call is refused, or undefined when it does not change files under the repository. */
export function repoWriteRefusal(_call: RepoWriteCall): string | undefined {
    return undefined;
}
