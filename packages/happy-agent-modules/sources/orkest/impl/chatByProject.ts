import { posix } from "node:path";

import type { AttendedSession } from "./OrkestAgencyClient.js";

/**
 * GHO-204 (ORKEST-CHAT-BY-PROJECT, D-31 and D-33) — every session belongs to a project and opens at its path.
 *
 * - The agent starts in the project's repository when Father names one that exists on this host, else in an empty
 *   `project` folder inside its task folder.
 * - It reads the repository freely and never writes there: its only writable place is `<task>/doc`, and a doc
 *   change is a proposal a person accepts (D-22). `repoWriteRefusal` is the guard behind that rule.
 */

/** Where a session's agent starts. */
export interface SessionPlacement {
    /** An absolute directory, or a path relative to the task folder (made empty by the task catalog). */
    readonly workingDirectory: string;
    /** The repository the agent starts in; null when it starts in the empty folder. */
    readonly repoPath: string | null;
}

/** The empty folder, relative to the task's own folder, a project with no repository opens in. */
export const EMPTY_PROJECT_FOLDER = "project";

/** The repository when Father named one and it is a directory on this host; otherwise the empty folder. */
export async function placementFor(
    repoPath: string | null | undefined,
    exists: (path: string) => Promise<boolean>,
): Promise<SessionPlacement> {
    if (typeof repoPath === "string" && repoPath.trim().length > 0) {
        const path = repoPath.trim();
        if (await exists(path)) return { workingDirectory: path, repoPath: path };
    }
    return { workingDirectory: EMPTY_PROJECT_FOLDER, repoPath: null };
}

const TASK_NAME_MAX = 120;

/** The task's display name: `[Project] name` when the project's title is known, never past the name limit. */
export function taskNameFor(title: string, projectTitle?: string | null): string {
    const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    const name = clean(title);
    const project = projectTitle === null || projectTitle === undefined ? "" : clean(projectTitle);
    if (project.length === 0) return name.slice(0, TASK_NAME_MAX);
    const tag = `[${project.slice(0, 40)}]`;
    if (name.startsWith(tag) || name.startsWith(`[${project}]`))
        return name.slice(0, TASK_NAME_MAX);
    return `${tag} ${name}`.slice(0, TASK_NAME_MAX);
}

/** The project a session belongs to: its scope's, else the feed's own `projectId`. */
export function sessionProjectId(session: AttendedSession): string | undefined {
    const id = session.scope?.projectId ?? session.projectId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The repository path Father named for the session's project, when it named one. */
export function sessionRepoPath(session: AttendedSession): string | undefined {
    const path = session.scope?.repoPath;
    return typeof path === "string" && path.trim().length > 0 ? path.trim() : undefined;
}

// ---- the write scope

export interface RepoWriteCall {
    readonly repoPath: string;
    /** The agent's working directory, which relative paths and commands resolve against. */
    readonly cwd: string;
    readonly tool: string;
    readonly args: unknown;
}

const REFUSAL =
    "This is the project's repository: read it freely, but never write, delete or run commands that change files in it. Your only writable place is the task's doc folder; propose doc changes with propose_document.";

/** Tools that write one file named by a path argument. */
const FILE_WRITE_TOOLS = new Set([
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "write",
    "edit",
    "search_replace",
    "str_replace",
    "write_file",
    "edit_file",
]);
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
const PATCH_TOOLS = new Set(["apply_patch"]);
/** Shell tools: the command's argument name and the directory argument's. */
const SHELL_TOOLS = new Set([
    "Bash",
    "PowerShell",
    "exec_command",
    "run_terminal_command",
    "shell",
    "bash",
]);
const COMMAND_KEYS = ["command", "cmd"] as const;
const CWD_KEYS = ["cwd", "workdir"] as const;

/**
 * Why a tool call is refused: it would change a file under the project's repository. Undefined when it does not.
 *
 * Paths are compared after resolving them against the agent's working directory, with slashes folded and, for a
 * Windows path (a drive letter or a backslash anywhere), case folded too. A shell command is read as a list of
 * simple commands: one that changes files (a known verb, a mutating git or package-manager subcommand, or a
 * redirect) is refused when a path it names resolves under the repository, or when it names no path and runs there.
 * This is a best-effort guard on what an agent writes by mistake or by instruction, not a sandbox: a command that
 * hides its target (a script, a variable, a subshell) is not understood.
 */
export function repoWriteRefusal(call: RepoWriteCall): string | undefined {
    const args = isRecord(call.args) ? call.args : undefined;
    if (args === undefined) return undefined;
    const fold =
        windowsLike(call.repoPath) || windowsLike(call.cwd) || process.platform === "win32";
    const repo = canonical(call.repoPath, undefined, fold);
    const cwd = canonical(call.cwd, undefined, fold);
    if (repo === undefined || cwd === undefined) return undefined;
    const under = (path: string | undefined) => path !== undefined && isUnder(path, repo);

    if (FILE_WRITE_TOOLS.has(call.tool)) {
        for (const key of PATH_KEYS) {
            const value = args[key];
            if (typeof value === "string" && under(canonical(value, cwd, fold))) return REFUSAL;
        }
        return undefined;
    }
    if (PATCH_TOOLS.has(call.tool)) {
        const base = canonical(firstString(args, CWD_KEYS) ?? cwd, cwd, fold) ?? cwd;
        const patch = typeof args["patch"] === "string" ? args["patch"] : "";
        return patchPaths(patch).some((path) => under(canonical(path, base, fold)))
            ? REFUSAL
            : undefined;
    }
    if (SHELL_TOOLS.has(call.tool)) {
        const command = firstString(args, COMMAND_KEYS);
        if (command === undefined) return undefined;
        const start = canonical(firstString(args, CWD_KEYS) ?? cwd, cwd, fold) ?? cwd;
        return shellWritesUnder(command, start, repo, fold) ? REFUSAL : undefined;
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
}

function windowsLike(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\");
}

/**
 * A path as a comparable string: forward slashes, dot segments resolved, no trailing slash, case folded when the
 * paths are Windows paths. Relative paths resolve against `cwd`; undefined for what cannot be resolved (`~`, empty).
 */
function canonical(path: string, cwd: string | undefined, fold: boolean): string | undefined {
    let text = path.trim().replaceAll("\\", "/");
    if (text.length === 0 || text.startsWith("~") || text.includes("$")) return undefined;
    // Git Bash writes C:/x as /c/x.
    const bash = /^\/([A-Za-z])(\/.*)?$/.exec(text);
    if (fold && bash) text = `${bash[1]}:${bash[2] ?? "/"}`;
    if (!/^[A-Za-z]:(\/|$)/.test(text) && !text.startsWith("/")) {
        if (cwd === undefined) return undefined;
        text = `${cwd}/${text}`;
    }
    const drive = /^([A-Za-z]:)(\/.*)?$/.exec(text);
    const head = drive ? drive[1]! : "";
    const rest = drive ? (drive[2] ?? "/") : text;
    const normal = posix.normalize(rest).replace(/\/+$/, "");
    const out = `${head}${normal}`;
    return fold ? out.toLowerCase() : out;
}

function isUnder(path: string, repo: string): boolean {
    return path === repo || path.startsWith(`${repo}/`);
}

/** The files a Codex-style patch (or a unified diff) adds, updates, deletes or moves to. */
function patchPaths(patch: string): string[] {
    const paths: string[] = [];
    for (const line of patch.split(/\r?\n/)) {
        const marker = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
        if (marker) {
            paths.push(marker[1]!.trim());
            continue;
        }
        const diff = /^(?:\+\+\+|---) (?:[ab]\/)?(\S.*)$/.exec(line);
        if (diff && diff[1] !== "/dev/null") paths.push(diff[1]!.trim());
    }
    return paths;
}

const MUTATING_VERBS = new Set([
    // POSIX
    "rm",
    "rmdir",
    "unlink",
    "mv",
    "cp",
    "mkdir",
    "touch",
    "tee",
    "truncate",
    "dd",
    "install",
    "ln",
    "chmod",
    "chown",
    "chgrp",
    "patch",
    "shred",
    "rename",
    // cmd
    "del",
    "erase",
    "rd",
    "ren",
    "move",
    "copy",
    "xcopy",
    "robocopy",
    "md",
    // PowerShell, with the usual aliases
    "remove-item",
    "move-item",
    "copy-item",
    "new-item",
    "set-content",
    "add-content",
    "out-file",
    "clear-content",
    "rename-item",
    "set-item",
    "ri",
    "mi",
    "cpi",
    "ni",
    "sc",
    "ac",
]);
const MUTATING_GIT = new Set([
    "add",
    "commit",
    "checkout",
    "switch",
    "reset",
    "restore",
    "clean",
    "stash",
    "merge",
    "rebase",
    "pull",
    "cherry-pick",
    "revert",
    "apply",
    "am",
    "rm",
    "mv",
    "tag",
    "worktree",
    "submodule",
    "gc",
    "prune",
    "init",
    "clone",
    "fetch",
]);
const PACKAGE_MANAGERS = new Map<string, Set<string>>([
    [
        "npm",
        new Set([
            "install",
            "i",
            "add",
            "remove",
            "rm",
            "uninstall",
            "update",
            "up",
            "ci",
            "link",
            "dedupe",
        ]),
    ],
    [
        "pnpm",
        new Set([
            "install",
            "i",
            "add",
            "remove",
            "rm",
            "uninstall",
            "update",
            "up",
            "link",
            "dedupe",
            "prune",
        ]),
    ],
    ["yarn", new Set(["install", "add", "remove", "upgrade", "link"])],
    ["bun", new Set(["install", "i", "add", "remove", "update", "link"])],
    ["pip", new Set(["install", "uninstall"])],
    ["pip3", new Set(["install", "uninstall"])],
    [
        "dotnet",
        new Set(["build", "publish", "restore", "clean", "new", "add", "remove", "pack", "format"]),
    ],
    ["cargo", new Set(["build", "clean", "add", "remove", "fmt", "install", "fix"])],
]);
const SHELLS = new Set([
    "bash",
    "sh",
    "zsh",
    "dash",
    "pwsh",
    "powershell",
    "cmd",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
]);
const COMMAND_FLAGS = new Set(["-c", "-command", "/c", "-lc", "-ic"]);
const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "nice", "exec"]);
const CD_VERBS = new Set(["cd", "chdir", "pushd", "set-location", "sl"]);
const IGNORED_TARGETS = new Set(["/dev/null", "nul", "$null", "/dev/stdout", "/dev/stderr"]);

/** Split a command line into simple commands, each a list of words with quotes removed. */
function simpleCommands(line: string): string[][] {
    const commands: string[][] = [];
    let words: string[] = [];
    let word = "";
    let has = false;
    let quote: string | null = null;
    const endWord = () => {
        if (has) words.push(word);
        word = "";
        has = false;
    };
    const endCommand = () => {
        endWord();
        if (words.length > 0) commands.push(words);
        words = [];
    };
    for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote !== null) {
            if (c === quote) quote = null;
            else word += c;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            has = true;
        } else if (c === ";" || c === "\n" || c === "\r") endCommand();
        else if ((c === "&" || c === "|") && !/[<>]/.test(line[i - 1] ?? "")) {
            if (line[i + 1] === c) i++;
            endCommand();
        } else if (c === " " || c === "\t") endWord();
        else {
            word += c;
            has = true;
        }
    }
    endCommand();
    return commands;
}

function shellWritesUnder(line: string, startCwd: string, repo: string, fold: boolean): boolean {
    let cwd = startCwd;
    for (const words of simpleCommands(line)) {
        // Redirects: `>`, `>>`, `2>`, `&>`, with the target glued on or the next word.
        const rest: string[] = [];
        for (let i = 0; i < words.length; i++) {
            const redirect = /^(?:\d*|&)>>?(.*)$/.exec(words[i]!);
            if (!redirect) {
                rest.push(words[i]!);
                continue;
            }
            const target = redirect[1]!.length > 0 ? redirect[1]! : (words[++i] ?? "");
            if (
                target.length === 0 ||
                target.startsWith("&") ||
                IGNORED_TARGETS.has(target.toLowerCase())
            )
                continue;
            const resolved = canonical(target, cwd, fold);
            if (resolved !== undefined && isUnder(resolved, repo)) return true;
        }
        while (
            rest.length > 0 &&
            (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!) || WRAPPERS.has(rest[0]!.toLowerCase()))
        )
            rest.shift();
        const verb = rest
            .shift()
            ?.toLowerCase()
            .replace(/^.*[\\/]/, "")
            .replace(/\.exe$/, "");
        if (verb === undefined) continue;

        if (CD_VERBS.has(verb)) {
            const target = rest.find((w) => !w.startsWith("-"));
            const next = target === undefined ? undefined : canonical(target, cwd, fold);
            if (next !== undefined) cwd = next;
            continue;
        }
        if (SHELLS.has(verb)) {
            const at = rest.findIndex((w) => COMMAND_FLAGS.has(w.toLowerCase()));
            const inner = at < 0 ? undefined : rest[at + 1];
            if (inner !== undefined && shellWritesUnder(inner, cwd, repo, fold)) return true;
            continue;
        }

        const flags = rest.filter(
            (w) => w.startsWith("-") || (verb === "cmd" && w.startsWith("/")),
        );
        const operands = rest.filter((w) => !flags.includes(w));
        let mutating = MUTATING_VERBS.has(verb);
        if (verb === "git") {
            const sub = operands.shift()?.toLowerCase();
            mutating = sub !== undefined && MUTATING_GIT.has(sub);
            if (sub === "branch")
                mutating =
                    operands.length > 0 ||
                    flags.some((f) => /^-(?:d|D|m|M|c|C)$|^--(?:delete|move|copy)$/.test(f));
            if (sub === "config")
                mutating = operands.length > 1 && !flags.some((f) => /^--(?:get|list)/.test(f));
        } else if (PACKAGE_MANAGERS.has(verb)) {
            const sub = operands.shift()?.toLowerCase();
            mutating = sub !== undefined && PACKAGE_MANAGERS.get(verb)!.has(sub);
        } else if (verb === "sed" || verb === "perl") {
            mutating = flags.some((f) => /^-[A-Za-z]*i/.test(f) || f === "--in-place");
        } else if (verb === "find") {
            mutating = rest.some((w) => w === "-delete");
        }
        if (!mutating) continue;

        const named = operands.map((w) => canonical(w, cwd, fold));
        if (named.some((p) => p !== undefined && isUnder(p, repo))) return true;
        // No operand to go by: the command acts on the directory it runs in.
        if (operands.length === 0 && isUnder(cwd, repo)) return true;
    }
    return false;
}
