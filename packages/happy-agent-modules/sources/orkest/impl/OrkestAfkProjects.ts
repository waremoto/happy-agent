import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const revisionPattern = /^[0-9a-f]{40}$/i;

export interface OrkestAfkProject {
    readonly id: string;
    readonly path: string;
    readonly policyRevision: string;
    readonly allowedRules: readonly string[];
    readonly deniedRules: readonly string[];
    readonly lockPath: string;
}

export type OrkestAfkProjectLockRelease = (() => Promise<void>) & {
    readonly isHeld: () => boolean;
};

interface ProjectEntry {
    readonly path: string;
    readonly policyRevision: string;
    readonly policyRole?: string;
}

interface ProjectFile {
    readonly tenant: string;
    readonly writableRoot: string;
    readonly projects: Readonly<Record<string, ProjectEntry>>;
}

function within(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
    const leftPath = resolve(left);
    const rightPath = resolve(right);
    return process.platform === "win32"
        ? leftPath.toLowerCase() === rightPath.toLowerCase()
        : leftPath === rightPath;
}

function rules(value: unknown, label: string): readonly string[] {
    if (value === undefined) return [];
    if (
        !Array.isArray(value) ||
        value.some(
            (item) =>
                typeof item !== "string" ||
                !/^[A-Za-z][A-Za-z0-9_-]*(?:\([^()]+\))?$/.test(item.trim()),
        )
    ) {
        throw new Error(`Trusted project ${label} rules are malformed.`);
    }
    return value.map((item) => item.trim());
}

export async function resolveOrkestAfkProject(
    filePath: string | undefined,
    tenant: string | undefined,
    projectId: string | undefined,
): Promise<OrkestAfkProject | undefined> {
    if (projectId === undefined) return undefined;
    if (filePath === undefined || tenant === undefined) {
        throw new Error("A server-bound project run needs a tenant project map.");
    }

    let file: ProjectFile;
    try {
        file = JSON.parse(await readFile(filePath, "utf8")) as ProjectFile;
    } catch {
        throw new Error("The trusted tenant project map is unreadable or invalid.");
    }
    if (
        file.tenant !== tenant ||
        typeof file.writableRoot !== "string" ||
        !isAbsolute(file.writableRoot) ||
        file.projects === null ||
        typeof file.projects !== "object" ||
        Array.isArray(file.projects)
    ) {
        throw new Error("The trusted tenant project map does not match this worker.");
    }
    const entry = file.projects[projectId];
    if (
        entry === undefined ||
        typeof entry.path !== "string" ||
        !isAbsolute(entry.path) ||
        !revisionPattern.test(entry.policyRevision)
    ) {
        throw new Error("The server-bound project has no valid trusted repository mapping.");
    }

    const root = await realpath(file.writableRoot);
    const trustedFile = await realpath(filePath);
    if (within(root, trustedFile)) {
        throw new Error("The trusted project map must live outside the tenant writable root.");
    }
    const canonicalProjects = new Map<string, string>();
    for (const [id, mapped] of Object.entries(file.projects)) {
        if (
            id.length === 0 ||
            mapped === null ||
            typeof mapped !== "object" ||
            typeof mapped.path !== "string" ||
            !isAbsolute(mapped.path) ||
            !revisionPattern.test(mapped.policyRevision)
        ) {
            throw new Error("The trusted tenant project map contains an invalid project entry.");
        }
        const canonicalPath = await realpath(mapped.path);
        if (!within(root, canonicalPath) || samePath(root, canonicalPath)) {
            throw new Error("A mapped repository escapes or aliases the tenant writable root.");
        }
        for (const [otherId, otherPath] of canonicalProjects) {
            if (within(otherPath, canonicalPath) || within(canonicalPath, otherPath)) {
                throw new Error(`Mapped repositories ${otherId} and ${id} overlap.`);
            }
        }
        canonicalProjects.set(id, canonicalPath);
    }
    const projectPath = canonicalProjects.get(projectId);
    if (projectPath === undefined) {
        throw new Error("The server-bound project has no valid trusted repository mapping.");
    }
    const { stdout: gitRootOutput } = await execFileAsync(
        "git",
        ["-C", projectPath, "rev-parse", "--show-toplevel"],
        { windowsHide: true, timeout: 10_000 },
    );
    const gitRoot = await realpath(gitRootOutput.trim());
    if (resolve(gitRoot) !== resolve(projectPath)) {
        throw new Error("The mapped path must be the canonical root of its repository.");
    }
    const gitMarker = await lstat(join(projectPath, ".git")).catch(() => undefined);
    if (gitMarker === undefined || !gitMarker.isDirectory() || gitMarker.isSymbolicLink()) {
        throw new Error(
            "The mapped project must be a repository checkout without linked Git metadata.",
        );
    }
    const canonicalGitMetadata = await realpath(join(projectPath, ".git"));
    if (!within(projectPath, canonicalGitMetadata)) {
        throw new Error("The project Git metadata escapes its repository directory.");
    }
    const lockPath = join(projectPath, ".run.lock");
    const lockInfo = await lstat(lockPath).catch(() => undefined);
    if (lockInfo?.isSymbolicLink() || (lockInfo?.isFile() && lockInfo.nlink > 1)) {
        throw new Error("The project lock path must be a regular, unlinked file.");
    }
    const policyRevision = entry.policyRevision.toLowerCase();
    const { stdout: json } = await execFileAsync(
        "git",
        [
            "--no-replace-objects",
            "-C",
            projectPath,
            "show",
            `${policyRevision}:.claude/settings.json`,
        ],
        { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    const basePermissions = parsePermissions(json, "base");
    let allowedRules = basePermissions.allow;
    let deniedRules = basePermissions.deny;
    if (entry.policyRole !== undefined) {
        if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(entry.policyRole)) {
            throw new Error("The trusted project policy role is invalid.");
        }
        const { stdout: roleJson } = await execFileAsync(
            "git",
            [
                "--no-replace-objects",
                "-C",
                projectPath,
                "show",
                `${policyRevision}:.claude/roles/${entry.policyRole}.json`,
            ],
            { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
        );
        const rolePermissions = parsePermissions(roleJson, "role");
        allowedRules = [...basePermissions.allow, ...rolePermissions.allow];
        deniedRules = [...new Set([...basePermissions.deny, ...rolePermissions.deny])];
    }
    return {
        id: projectId,
        path: projectPath,
        policyRevision,
        allowedRules,
        deniedRules,
        lockPath,
    };
}

function parsePermissions(
    json: string,
    source: "base" | "role",
): { readonly allow: readonly string[]; readonly deny: readonly string[] } {
    let settings: { permissions?: { allow?: unknown; deny?: unknown } };
    try {
        settings = JSON.parse(json) as typeof settings;
    } catch {
        throw new Error(`The pinned project ${source} permission settings are malformed.`);
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
        throw new Error(`The pinned project ${source} permission settings are malformed.`);
    }
    const permissions = settings.permissions;
    if (
        permissions !== undefined &&
        (permissions === null || typeof permissions !== "object" || Array.isArray(permissions))
    ) {
        throw new Error(`The pinned project ${source} permission settings are malformed.`);
    }
    return {
        allow: rules(permissions?.allow, `${source} allow`),
        deny: rules(permissions?.deny, `${source} deny`),
    };
}

const LOCK_SCRIPT = String.raw`
import os, sys
import stat
path = sys.argv[1]
flags = os.O_RDWR | os.O_CREAT
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o666)
info = os.fstat(fd)
path_info = os.stat(path, follow_symlinks=False)
if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_ISLNK(path_info.st_mode) or not os.path.samestat(info, path_info):
    os.close(fd)
    sys.exit(4)
f = os.fdopen(fd, "r+b")
if os.name == "nt":
    import msvcrt
    f.seek(0, os.SEEK_END)
    f.seek(0)
    try:
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        sys.exit(3)
else:
    import fcntl
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(3)
sys.stdout.write("LOCKED\n")
sys.stdout.flush()
sys.stdin.read()
`;

export { LOCK_SCRIPT as ORKEST_AFK_PROJECT_LOCK_SCRIPT };

export async function acquireOrkestAfkProjectLock(
    lockPath: string,
): Promise<OrkestAfkProjectLockRelease> {
    const configuredPython = process.env.ORKEST_AFK_PYTHON?.trim();
    const python = configuredPython || (process.platform === "win32" ? "py" : "python3");
    const pythonPrefix =
        process.platform === "win32" && configuredPython === undefined ? ["-3.12"] : [];
    const child = spawn(python, [...pythonPrefix, "-I", "-S", "-u", "-c", LOCK_SCRIPT, lockPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk.slice(0, 500)));
    let ready = false;
    await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        const timer = setTimeout(() => {
            void new Promise<void>((resolveExit) => {
                if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
                child.once("exit", () => resolveExit());
                child.kill();
            }).finally(() => rejectReady(new Error("The project lock did not become ready.")));
        }, 10_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            output += chunk;
            if (output.replaceAll("\r\n", "\n").includes("LOCKED\n")) {
                ready = true;
                clearTimeout(timer);
                resolveReady();
            }
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            rejectReady(new Error(`Could not start the project lock helper: ${error.message}`));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (!ready) {
                rejectReady(
                    new Error(
                        code === 3
                            ? "The project is locked by another run."
                            : `The project lock helper exited (${code ?? "signal"})${stderr ? `: ${stderr.trim()}` : ""}.`,
                    ),
                );
            }
        });
    });
    let released = false;
    let helperAlive = true;
    child.once("exit", () => (helperAlive = false));
    const release = async () => {
        if (released) return;
        released = true;
        child.stdin.end();
        await new Promise<void>((resolveExit) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
            child.once("exit", () => resolveExit());
        });
    };
    return Object.assign(release, { isHeld: () => helperAlive && !released });
}

export function projectRuleDecision(
    rules: readonly string[],
    tool: string,
    projectRelativePath?: string,
): boolean {
    for (const rule of rules) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(rule);
        if (match === null || match[1] !== tool) continue;
        if (match[2] === undefined) return true;
        if (
            projectRelativePath === undefined ||
            tool === "Bash" ||
            tool === "WebFetch" ||
            tool === "WebSearch"
        )
            continue;
        const pattern = match[2].replaceAll("\\", "/");
        if (pattern === "//**") continue;
        if (pattern.startsWith("/") || pattern.split("/").includes("..")) continue;
        let expression = "";
        for (let index = 0; index < pattern.length; index += 1) {
            const character = pattern[index];
            if (character === "*" && pattern[index + 1] === "*") {
                expression += ".*";
                index += 1;
            } else if (character === "*") expression += "[^/]*";
            else if (character === "?") expression += "[^/]";
            else
                expression += /[.+^${}()|[\]\\]/.test(character ?? "")
                    ? `\\${character}`
                    : character;
        }
        if (
            new RegExp(`^${expression}$`, process.platform === "win32" ? "i" : "").test(
                projectRelativePath.replaceAll("\\", "/"),
            )
        )
            return true;
    }
    return false;
}

export async function projectPathsResolveInside(
    projectPath: string,
    tool: string,
    argumentsValue: unknown,
): Promise<{ readonly inside: boolean; readonly paths: readonly string[] }> {
    if (
        argumentsValue === null ||
        typeof argumentsValue !== "object" ||
        Array.isArray(argumentsValue)
    ) {
        return { inside: false, paths: [] };
    }
    const record = argumentsValue as Record<string, unknown>;
    const paths: string[] = [];
    for (const key of [
        "file_path",
        "path",
        "paths",
        "notebook_path",
        "directory",
        "dir",
        "target_directory",
        "absolute_path",
        "image_path",
    ]) {
        const value = record[key];
        if (value === undefined || value === null) continue;
        const values = Array.isArray(value) ? value : [value];
        if (values.some((candidate) => typeof candidate !== "string" || candidate.trim() === "")) {
            return { inside: false, paths };
        }
        paths.push(...(values as string[]));
    }
    const toolPattern =
        (tool === "Glob" || tool === "list_dir") && typeof record.pattern === "string"
            ? [record.pattern]
            : [];
    const checkedPaths = [...paths, ...toolPattern];
    if (checkedPaths.length === 0) return { inside: false, paths: [] };
    const root = await realpath(projectPath);
    const canonicalPaths: string[] = [];
    for (const candidate of checkedPaths) {
        const drivePrefix = /^[A-Za-z]:[\\/]/.test(candidate) ? 2 : 0;
        if (
            candidate.startsWith("~") ||
            candidate.slice(drivePrefix).includes(":") ||
            candidate.includes("\0") ||
            candidate.replaceAll("\\", "/").split("/").includes("..")
        ) {
            return { inside: false, paths: [] };
        }
        const target = resolve(root, candidate);
        const suffix: string[] = [];
        let existing = target;
        let info: Awaited<ReturnType<typeof lstat>> | undefined;
        while (info === undefined) {
            info = await lstat(existing).catch(() => undefined);
            if (info === undefined) {
                const parent = dirname(existing);
                if (parent === existing) return { inside: false, paths: [] };
                suffix.unshift(existing.slice(parent.length + 1));
                existing = parent;
            }
        }
        if (info.isSymbolicLink()) {
            try {
                existing = await realpath(existing);
                info = await lstat(existing);
            } catch {
                return { inside: false, paths: [] };
            }
        } else {
            existing = await realpath(existing).catch(() => "");
        }
        if (existing === "" || !within(root, existing) || (info.isFile() && info.nlink > 1)) {
            return { inside: false, paths: [] };
        }
        const canonical = resolve(existing, ...suffix);
        if (!within(root, canonical)) return { inside: false, paths: [] };
        canonicalPaths.push(canonical);
    }
    return { inside: true, paths: canonicalPaths };
}

export function projectPathIsProtected(relativePath: string): boolean {
    const path = relativePath.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
    return (
        path === ".git" ||
        path.startsWith(".git/") ||
        path === ".run.lock" ||
        path === ".claude" ||
        path.startsWith(".claude/") ||
        path === "toma.project.yaml" ||
        path === "agency.up.yaml" ||
        path === "agency.yaml" ||
        path === "agents.md" ||
        path === "claude.md"
    );
}
