import { canonical, isUnder, simpleCommands, windowsLike } from "./chatByProject.js";

/**
 * GHO-207.2.3 — a project's harness mode: the owner of a project session works in the repository the way Claude Code
 * or Codex does at that path, without a card for each in-path read, write, test or local commit.
 *
 * - It is off unless the repository's committed `.orkest/harness-mode.json` says `{"schema": 1, "enabled": true}`.
 *   Only the committed bytes count (`git show HEAD:`), so an agent's uncommitted edit of the file switches nothing.
 * - It applies to a `workspace_write` session that a person started. When the file lists `owners`
 *   (`"<provider>:<id>"`), the session's starter must be one of them.
 * - Under it, `harnessModeAllows` answers a native tool question for the person when the action stays inside the
 *   repository and is local. Everything else still reaches the person's card: anything outside the path, `git push`
 *   and other remote git, deploys, network tools, package installs, secrets, the harness-mode file itself, command
 *   substitution and anything this classifier does not understand. It is a best-effort guard on what an agent
 *   does by mistake or by instruction, not a sandbox: a script in the repository can still do anything its author
 *   wrote, as it can when the person runs it.
 */

export const HARNESS_MODE_FILE = ".orkest/harness-mode.json";

export interface HarnessModeFile {
    readonly enabled: boolean;
    /** `"<provider>:<id>"` of the people it applies to; undefined means whoever started the session. */
    readonly owners?: readonly string[];
    /** Why the file did not switch harness mode on, when it exists but is not valid. */
    readonly problem?: string;
}

/** The harness mode a repository's committed file asks for. `committed` is the file's text at HEAD, or undefined. */
export function parseHarnessModeFile(committed: string | undefined): HarnessModeFile {
    if (committed === undefined) return { enabled: false };
    let value: unknown;
    try {
        value = JSON.parse(committed);
    } catch {
        return { enabled: false, problem: `${HARNESS_MODE_FILE} is not JSON.` };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return { enabled: false, problem: `${HARNESS_MODE_FILE} is not an object.` };
    const record = value as Record<string, unknown>;
    if (record["schema"] !== 1)
        return { enabled: false, problem: `${HARNESS_MODE_FILE} has no schema 1.` };
    const owners = record["owners"];
    if (
        owners !== undefined &&
        (!Array.isArray(owners) ||
            owners.length === 0 ||
            owners.some((o) => typeof o !== "string" || !/^[^:\s]+:\S+$/.test(o)))
    )
        return {
            enabled: false,
            problem: `${HARNESS_MODE_FILE} owners must be a nonempty list of "provider:id".`,
        };
    return {
        enabled: record["enabled"] === true,
        ...(owners === undefined ? {} : { owners: owners as string[] }),
    };
}

/** `"<provider>:<id>"` of a feed row's `startedBy`, or undefined when no person started it. */
export function starterOf(startedBy: unknown): string | undefined {
    if (typeof startedBy !== "object" || startedBy === null) return undefined;
    const record = startedBy as Record<string, unknown>;
    const provider = record["provider"] ?? record["Provider"];
    const id = record["id"] ?? record["Id"];
    return typeof provider === "string" &&
        provider.length > 0 &&
        typeof id === "string" &&
        id.length > 0
        ? `${provider}:${id}`
        : undefined;
}

/** Whether harness mode applies to one session. */
export function harnessModeApplies(input: {
    readonly file: HarnessModeFile;
    readonly permissionMode: string;
    readonly startedBy: unknown;
}): boolean {
    if (!input.file.enabled || input.permissionMode !== "workspace_write") return false;
    const starter = starterOf(input.startedBy);
    if (starter === undefined) return false;
    return input.file.owners === undefined || input.file.owners.includes(starter);
}

/** What a native agent asks: the same fields the person's card shows. */
export interface HarnessModeQuestion {
    readonly provider: "claude" | "codex";
    readonly action: string;
    readonly input: unknown;
}

/** Claude Code tools that only read, by the argument that names what they read. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Claude Code tools that touch no file and no network themselves (their own tools ask again). */
const LOCAL_TOOLS = new Set([
    "TodoWrite",
    "Task",
    "Agent",
    "Skill",
    "SlashCommand",
    "BashOutput",
    "KillShell",
    "KillBash",
    "ExitPlanMode",
]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

/** Commands that reach the network, deploy or change the machine: always the person's call. */
const ASK_VERBS = new Set([
    "curl",
    "wget",
    "invoke-webrequest",
    "iwr",
    "invoke-restmethod",
    "irm",
    "start-bitstransfer",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "ftp",
    "nc",
    "ncat",
    "telnet",
    "gh",
    "glab",
    "docker",
    "docker-compose",
    "podman",
    "kubectl",
    "helm",
    "az",
    "aws",
    "gcloud",
    "terraform",
    "vercel",
    "netlify",
    "wrangler",
    "fly",
    "flyctl",
    "sudo",
    "runas",
    "su",
    "reg",
    "regedit",
    "netsh",
    "setx",
    "schtasks",
    "sc.exe",
    "set-executionpolicy",
    "start-process",
    "invoke-expression",
    "iex",
    "eval",
    "source",
    "wsl",
    "shutdown",
    "restart-computer",
    "stop-computer",
    "taskkill",
    "stop-process",
    "kill",
    "pkill",
    "killall",
]);
/** git subcommands that stay in the repository and keep its history (read, stage, commit). */
const LOCAL_GIT = new Set([
    "status",
    "diff",
    "log",
    "show",
    "add",
    "commit",
    "rev-parse",
    "rev-list",
    "ls-files",
    "ls-tree",
    "grep",
    "blame",
    "describe",
    "shortlog",
    "mv",
    "rm",
    "cat-file",
    "merge-base",
    "check-ignore",
    "name-rev",
    "for-each-ref",
]);
/** Package-manager subcommands that download or publish: the person's call. */
const NETWORK_PACKAGE = new Map<string, Set<string>>([
    ["npm", new Set(["install", "i", "add", "ci", "update", "up", "publish", "login", "adduser", "link", "exec", "x"])],
    ["pnpm", new Set(["install", "i", "add", "update", "up", "publish", "login", "link", "dlx", "exec"])],
    ["yarn", new Set(["install", "add", "upgrade", "publish", "login", "link", "dlx"])],
    ["bun", new Set(["install", "i", "add", "update", "publish", "link", "x"])],
    ["pip", new Set(["install", "download", "uninstall"])],
    ["pip3", new Set(["install", "download", "uninstall"])],
    ["uv", new Set(["pip", "add", "sync", "tool"])],
    ["cargo", new Set(["install", "publish", "login", "add"])],
    ["dotnet", new Set(["restore", "add", "nuget", "tool", "publish", "workload"])],
    ["nuget", new Set(["push", "install", "restore"])],
    ["winget", new Set(["install", "upgrade", "uninstall"])],
    ["choco", new Set(["install", "upgrade", "uninstall"])],
    ["scoop", new Set(["install", "update", "uninstall"])],
]);
/** make targets that deploy or touch running services. */
const DEPLOY_TARGET = /(?:deploy|release|publish|push|prod|upload|install|^up$|^down$|restart|recover)/i;
const SHELLS = new Set(["bash", "sh", "zsh", "pwsh", "powershell", "cmd"]);
const COMMAND_FLAGS = new Set(["-c", "-command", "/c", "-lc"]);
const WRAPPERS = new Set(["command", "env", "time", "nohup", "nice", "exec"]);
const CD_VERBS = new Set(["cd", "chdir", "pushd", "set-location", "sl"]);
const IGNORED_TARGETS = new Set(["/dev/null", "nul", "$null", "/dev/stdout", "/dev/stderr"]);

/** A path or word that names a secret: an env file, a key, a credentials file. */
function secretLike(word: string): boolean {
    const name = word.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
    return (
        /^\.env(?:\.|$)/.test(name) ||
        /\.(?:pem|key|p12|pfx|keystore)$/.test(name) ||
        /^id_(?:rsa|ed25519|ecdsa|dsa)/.test(name) ||
        /^(?:credentials|secrets?)(?:\.|$)/.test(name) ||
        name === ".npmrc" ||
        name === ".netrc" ||
        name === ".git-credentials"
    );
}

interface Place {
    readonly repo: string;
    readonly fold: boolean;
}

/** Whether a file path (relative to `cwd`) is one harness mode may write: in the repository, not git's, not secret. */
function writable(path: string, cwd: string, place: Place): boolean {
    const resolved = canonical(path, cwd, place.fold);
    if (resolved === undefined || !isUnder(resolved, place.repo)) return false;
    const inside = resolved.slice(place.repo.length).replace(/^\//, "");
    const lower = inside.toLowerCase();
    if (lower === ".git" || lower.startsWith(".git/")) return false;
    if (lower === HARNESS_MODE_FILE) return false;
    return !secretLike(inside);
}

function readable(path: string, cwd: string, place: Place): boolean {
    const resolved = canonical(path, cwd, place.fold);
    return resolved !== undefined && isUnder(resolved, place.repo) && !secretLike(resolved);
}

/** Whether a word looks like a path (so it must stay in the repository). */
function pathLike(word: string): boolean {
    return (
        /^[A-Za-z]:[\\/]/.test(word) ||
        word.startsWith("/") ||
        word.startsWith("~") ||
        word.startsWith(".") ||
        word.includes("/") ||
        word.includes("\\")
    );
}

/** Whether a shell command line stays local and inside the repository. */
function shellStaysIn(line: string, startCwd: string, place: Place, depth = 0): boolean {
    if (depth > 3) return false;
    // Substitutions and here-strings hide what runs.
    if (/\$\(|`|<\(|>\(|\$\{/.test(line)) return false;
    if (line.toLowerCase().includes(HARNESS_MODE_FILE)) return false;
    let cwd = startCwd;
    if (!isUnder(cwd, place.repo)) return false;
    for (const words of simpleCommands(line)) {
        if (words.some((w) => secretLike(w))) return false;
        const rest: string[] = [];
        for (let i = 0; i < words.length; i++) {
            const redirect = /^(?:\d*|&)>>?(.*)$/.exec(words[i]!);
            if (!redirect) {
                rest.push(words[i]!);
                continue;
            }
            const target = redirect[1]!.length > 0 ? redirect[1]! : (words[++i] ?? "");
            if (target.length === 0 || target.startsWith("&")) continue;
            if (IGNORED_TARGETS.has(target.toLowerCase())) continue;
            if (!writable(target, cwd, place)) return false;
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
        if (ASK_VERBS.has(verb)) return false;
        if (CD_VERBS.has(verb)) {
            const target = rest.find((w) => !w.startsWith("-"));
            const next = target === undefined ? undefined : canonical(target, cwd, place.fold);
            if (next === undefined || !isUnder(next, place.repo)) return false;
            cwd = next;
            continue;
        }
        if (SHELLS.has(verb)) {
            const at = rest.findIndex((w) => COMMAND_FLAGS.has(w.toLowerCase()));
            if (at >= 0) {
                const inner = rest[at + 1];
                if (inner === undefined || !shellStaysIn(inner, cwd, place, depth + 1))
                    return false;
                continue;
            }
        }
        const flags = rest.filter((w) => w.startsWith("-"));
        const operands = rest.filter((w) => !w.startsWith("-"));
        if (verb === "git") {
            // `git -C <dir>` must stay in the repository too.
            const at = rest.indexOf("-C");
            if (at >= 0) {
                const dir = rest[at + 1];
                const next = dir === undefined ? undefined : canonical(dir, cwd, place.fold);
                if (next === undefined || !isUnder(next, place.repo)) return false;
                operands.splice(operands.indexOf(dir!), 1);
            }
            const sub = operands.shift()?.toLowerCase();
            if (sub === undefined) return false;
            if (sub === "branch") {
                if (operands.length > 0 || flags.some((f) => /^-(?:d|D|m|M|c|C|f)$|^--(?:delete|move|copy|force|set-upstream)/.test(f)))
                    return false;
            } else if (!LOCAL_GIT.has(sub)) return false;
            if (sub === "commit" && flags.some((f) => /^--(?:amend|no-verify)$|^-n$/.test(f)))
                return false;
        } else if (NETWORK_PACKAGE.has(verb)) {
            const sub = operands[0]?.toLowerCase();
            if (sub !== undefined && NETWORK_PACKAGE.get(verb)!.has(sub)) return false;
            if (verb === "npx" || verb === "pnpx" || verb === "bunx") return false;
        } else if (verb === "npx" || verb === "pnpx" || verb === "bunx" || verb === "uvx") {
            // npx downloads what it does not find; a local runner (vitest, tsc, ...) is allowed with --no-install.
            if (!flags.includes("--no-install") && !flags.includes("--offline")) return false;
        } else if (verb === "make" || verb === "mingw32-make") {
            if (operands.some((t) => DEPLOY_TARGET.test(t))) return false;
            const at = rest.indexOf("-C");
            if (at >= 0) {
                const dir = rest[at + 1];
                const next = dir === undefined ? undefined : canonical(dir, cwd, place.fold);
                if (next === undefined || !isUnder(next, place.repo)) return false;
            }
        }
        for (const word of operands) {
            if (!pathLike(word)) continue;
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return false; // a URL
            const resolved = canonical(word, cwd, place.fold);
            if (resolved === undefined || !isUnder(resolved, place.repo)) return false;
        }
    }
    return true;
}

/** Whether harness mode answers this question for the person (true), or the person's card asks (false). */
export function harnessModeAllows(repoPath: string, question: HarnessModeQuestion): boolean {
    const fold = windowsLike(repoPath) || process.platform === "win32";
    const repo = canonical(repoPath, undefined, fold);
    if (repo === undefined) return false;
    const place: Place = { repo, fold };
    const input =
        typeof question.input === "object" && question.input !== null && !Array.isArray(question.input)
            ? (question.input as Record<string, unknown>)
            : {};
    if (question.provider === "claude") {
        const tool = question.action.split(":")[0]!.trim();
        if (LOCAL_TOOLS.has(tool)) return true;
        const named = PATH_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === "string");
        if (READ_TOOLS.has(tool)) return named.every((p) => readable(p, repo, place));
        if (WRITE_TOOLS.has(tool))
            return named.length > 0 && named.every((p) => writable(p, repo, place));
        if (SHELL_TOOLS.has(tool)) {
            const command = input["command"];
            return typeof command === "string" && shellStaysIn(command, repo, place);
        }
        return false;
    }
    const method = input["method"];
    if (method === "item/commandExecution/requestApproval") {
        const raw = input["command"];
        const command = Array.isArray(raw)
            ? raw.filter((w): w is string => typeof w === "string").map(quoteWord).join(" ")
            : raw;
        const cwdRaw = typeof input["cwd"] === "string" ? input["cwd"] : repoPath;
        const cwd = canonical(cwdRaw, repo, fold);
        return typeof command === "string" && cwd !== undefined && shellStaysIn(command, cwd, place);
    }
    if (method === "item/fileChange/requestApproval") {
        const changes = Array.isArray(input["changes"]) ? input["changes"] : [];
        const paths = changes.map((c) =>
            typeof c === "object" && c !== null ? (c as Record<string, unknown>)["path"] : undefined,
        );
        return (
            paths.length > 0 &&
            paths.every((p) => typeof p === "string" && writable(p, repo, place))
        );
    }
    return false;
}

function quoteWord(word: string): string {
    return /[\s"';&|<>]/.test(word) ? `"${word.replaceAll('"', "")}"` : word;
}
