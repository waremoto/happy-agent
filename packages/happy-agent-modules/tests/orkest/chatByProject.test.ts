import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
    attendedSessionSchema,
    type AttendedSession,
} from "../../sources/orkest/impl/OrkestAgencyClient.js";
import {
    isProjectSession,
    projectSessionState,
} from "../../sources/orkest/impl/projectSessionOpen.js";
import { projectSessionPreamble } from "../../sources/orkest/impl/projectSessionPreamble.js";
import {
    placementFor,
    repoWriteRefusal,
    sessionProjectId,
    sessionRepoPath,
    taskNameFor,
} from "../../sources/orkest/impl/chatByProject.js";

/**
 * GHO-204 (ORKEST-CHAT-BY-PROJECT, D-33) — a session opens in its project's repository and never writes there; its
 * only writable place is `<task>/doc`.
 */

const REPO = "D:/ware/Ghost";
const TASK = "C:/Users/julio/.orkest/happy-attended/happy/Tasks/t_1";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

function session(extra: Record<string, unknown> = {}): AttendedSession {
    return {
        runId: "0195f3a0-0000-7000-8000-000000000001",
        state: "admitted",
        harness: "claude",
        permissionMode: "workspace_write",
        title: "Ghost",
        brief: "",
        workLabel: "p-1",
        endRequestedAt: null,
        intentId: "0195f3a0-0000-7000-8000-0000000000aa",
        ownerJobRef: null,
        fence: 0,
        ...extra,
    } as AttendedSession;
}

describe("the working directory", () => {
    it("is the project's repository when it exists, else an empty project folder", async () => {
        const dir = await mkdtemp(join(tmpdir(), "chatproj-"));
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const exists = async (path: string) => {
            try {
                return (await stat(path)).isDirectory();
            } catch {
                return false;
            }
        };

        expect(await placementFor(dir, exists)).toEqual({ workingDirectory: dir, repoPath: dir });
        expect(await placementFor(null, exists)).toEqual({
            workingDirectory: "project",
            repoPath: null,
        });
        // A path from Father that is not on this host opens the empty folder, never a missing directory.
        expect(await placementFor(join(dir, "nope"), exists)).toEqual({
            workingDirectory: "project",
            repoPath: null,
        });
    });

    it("reads the project and repo from a ticket session as well as a project session", () => {
        const ticket = session({
            scope: { kind: "ticket", projectId: "p-1", path: null, repoPath: REPO },
        });
        expect(Value.Check(attendedSessionSchema, ticket)).toBe(true);
        expect([sessionProjectId(ticket), sessionRepoPath(ticket)]).toEqual(["p-1", REPO]);
        // A ticket session is not a project session: its composer is still drafted with the work item.
        expect(isProjectSession(ticket)).toBe(false);

        const project = session({ scope: { kind: "project", projectId: "p-2", path: null } });
        expect(isProjectSession(project)).toBe(true);
        expect([sessionProjectId(project), sessionRepoPath(project)]).toEqual(["p-2", undefined]);

        // An old row: no scope, no project.
        const old = session();
        expect([sessionProjectId(old), sessionRepoPath(old), isProjectSession(old)]).toEqual([
            undefined,
            undefined,
            false,
        ]);
        expect(sessionProjectId(session({ projectId: "p-3" }))).toBe("p-3");
    });

    it("carries the repo into a project session's state", () => {
        const project = session({
            scope: { kind: "project", projectId: "p-1", path: null, repoPath: REPO },
        });
        if (!isProjectSession(project)) throw new Error("expected a project session");
        expect(projectSessionState(project, TASK, REPO).repoPath).toBe(REPO);
        expect(projectSessionState(project, TASK, null).repoPath).toBeNull();
    });
});

describe("the task name", () => {
    it("starts with the project title when it is known", () => {
        expect(taskNameFor("WAR-7: Tighten login", "Ghost")).toBe("[Ghost] WAR-7: Tighten login");
        expect(taskNameFor("Ghost", null)).toBe("Ghost");
        expect(taskNameFor("Ghost", undefined)).toBe("Ghost");
        expect(taskNameFor("[Ghost] already", "Ghost")).toBe("[Ghost] already");
        expect(taskNameFor("x".repeat(300), "Ghost").length).toBeLessThanOrEqual(120);
        expect(taskNameFor("x".repeat(300), "Ghost").startsWith("[Ghost] ")).toBe(true);
    });
});

describe("the preamble", () => {
    const base = {
        title: "Ghost",
        scope: { kind: "project" as const, projectId: "p-1", path: null },
        permissionMode: "workspace_write",
        docs: 2,
    };

    it("tells the agent where it starts and where it may write", () => {
        const text = projectSessionPreamble({
            ...base,
            workingDirectory: { repoPath: REPO, taskPath: TASK },
        });
        expect(text).toContain(
            `You start in the project's repository at ${REPO}. Read it freely. Never write, delete or run commands that change files there. Your only writable place is ${TASK}/doc; propose doc changes with propose_document.`,
        );
        // The existing contract stays.
        expect(text).toContain("propose_document");
        expect(text).toContain("the only place you write");
    });

    it("says so when the project has no repository to start in", () => {
        const text = projectSessionPreamble({
            ...base,
            docs: null,
            workingDirectory: { repoPath: null, taskPath: TASK },
        });
        expect(text).toContain(`${TASK}/project`);
        expect(text).not.toContain("You start in the project's repository");
    });

    it("is unchanged for a caller that names no working directory", () => {
        expect(projectSessionPreamble(base)).not.toContain("You start in");
    });
});

describe("the write scope", () => {
    const refused = (tool: string, args: unknown, cwd = REPO) =>
        repoWriteRefusal({ repoPath: REPO, cwd, tool, args });

    it("refuses a file write, edit or patch under the repository, even in workspace_write", () => {
        expect(refused("Write", { file_path: "D:/ware/Ghost/src/a.cs", content: "x" })).toMatch(
            /repository/,
        );
        expect(
            refused("Edit", {
                file_path: "D:/ware/Ghost/CLAUDE.md",
                old_string: "a",
                new_string: "b",
            }),
        ).toBeDefined();
        expect(refused("write", { file_path: "D:/ware/Ghost/a.txt", content: "x" })).toBeDefined();
        expect(refused("search_replace", { file_path: "D:/ware/Ghost/a.txt" })).toBeDefined();
        expect(refused("Write", { path: "D:/ware/Ghost/a.txt", content: "x" })).toBeDefined();
        // A relative path resolves against the working directory, which is the repository.
        expect(refused("Write", { file_path: "docs/ROADMAP.md", content: "x" })).toBeDefined();
        expect(refused("Write", { file_path: "../Ghost/docs/x.md", content: "x" })).toBeDefined();
        // Dot segments cannot climb out of the task folder into the repository.
        expect(
            refused("Write", {
                file_path: `${TASK}/doc/../../../../../../../../ware/Ghost/x.md`,
                content: "x",
            }),
        ).toBeDefined();
        for (const patch of [
            "*** Begin Patch\n*** Add File: src/new.cs\n+x\n*** End Patch",
            "*** Begin Patch\n*** Update File: D:/ware/Ghost/a.cs\n@@\n-a\n+b\n*** End Patch",
            "*** Begin Patch\n*** Delete File: a.cs\n*** End Patch",
            "*** Begin Patch\n*** Update File: elsewhere.txt\n*** Move to: D:/ware/Ghost/b.txt\n*** End Patch",
        ])
            expect(refused("apply_patch", { patch }, REPO), patch).toBeDefined();
    });

    it("compares Windows paths by case and slash", () => {
        expect(
            refused("Write", { file_path: "d:\\WARE\\ghost\\src\\a.cs", content: "x" }),
        ).toBeDefined();
        expect(
            refused("Write", { file_path: "D:\\ware\\Ghost\\\\src//a.cs", content: "x" }),
        ).toBeDefined();
        expect(
            repoWriteRefusal({
                repoPath: "D:\\ware\\Ghost",
                cwd: "D:\\ware\\Ghost",
                tool: "Write",
                args: { file_path: "d:/WARE/GHOST/x.md", content: "x" },
            }),
        ).toBeDefined();
        // A sibling that merely shares the prefix is not the repository.
        expect(
            refused("Write", { file_path: "D:/ware/Ghost-notes/a.md", content: "x" }),
        ).toBeUndefined();
    });

    it("lets the task's doc folder be written", () => {
        expect(
            refused("Write", { file_path: `${TASK}/doc/ROADMAP.md`, content: "x" }),
        ).toBeUndefined();
        expect(
            refused("Edit", { file_path: `${TASK}/doc/a/b.md`, old_string: "a", new_string: "b" }),
        ).toBeUndefined();
        expect(
            refused(
                "apply_patch",
                { patch: `*** Begin Patch\n*** Add File: ${TASK}/doc/n.md\n+x\n*** End Patch` },
                TASK,
            ),
        ).toBeUndefined();
        expect(
            refused("Write", { file_path: "doc/ROADMAP.md", content: "x" }, TASK),
        ).toBeUndefined();
    });

    it("refuses a shell command that changes files in the repository", () => {
        for (const command of [
            "rm -rf src",
            "rm D:/ware/Ghost/a.txt",
            "echo hi > notes.txt",
            "cat a >> D:\\ware\\Ghost\\log.txt",
            "git commit -am x",
            "git checkout -b other",
            "git reset --hard",
            "sed -i s/a/b/ CLAUDE.md",
            "mkdir out && ls",
            "ls && touch a",
            "npm install",
            "mv a b",
            "cp x D:/ware/Ghost/y",
            "Remove-Item -Recurse src",
            "Set-Content -Path a.txt -Value x",
            "ls | tee out.txt",
        ])
            expect(refused("Bash", { command }), command).toBeDefined();
        expect(refused("exec_command", { cmd: "rm -rf .", workdir: REPO })).toBeDefined();
        expect(refused("run_terminal_command", { command: "git clean -fd" })).toBeDefined();
        expect(refused("Bash", { command: "ls", cwd: REPO })).toBeUndefined();
        // A mutating command run from the task folder against the repo by path.
        expect(refused("Bash", { command: `rm ${REPO}/a.txt` }, TASK)).toBeDefined();
        expect(refused("Bash", { command: `cd ${REPO} && touch a` }, TASK)).toBeDefined();
    });

    it("lets reads and the doc folder through", () => {
        for (const command of [
            "ls -la",
            "git status",
            "git log --oneline -5",
            "git diff HEAD~1",
            "git show HEAD:CLAUDE.md",
            "grep -rn foo src | head",
            "rg TODO",
            "cat CLAUDE.md",
            "find . -name '*.cs'",
            "echo hi > /dev/null",
            "dotnet --version",
            "Get-ChildItem",
        ])
            expect(refused("Bash", { command }), command).toBeUndefined();
        expect(refused("Read", { file_path: "D:/ware/Ghost/CLAUDE.md" })).toBeUndefined();
        expect(refused("Glob", { pattern: "**/*.cs" })).toBeUndefined();
        expect(refused("Grep", { pattern: "x" })).toBeUndefined();
        expect(refused("Bash", { command: `echo x > ${TASK}/doc/a.md` })).toBeUndefined();
        expect(refused("Bash", { command: `cd ${TASK}/doc && echo x > a.md` })).toBeUndefined();
        expect(refused("Bash", { command: `rm ${TASK}/doc/a.md` })).toBeUndefined();
        expect(refused("propose_document", { path: "docs/a.md", why: "x" })).toBeUndefined();
        // A call with no usable arguments is not a write.
        expect(refused("Write", undefined)).toBeUndefined();
        expect(refused("Bash", { command: 7 })).toBeUndefined();
    });

    it("also guards a Windows-style task folder written through a PowerShell redirect", () => {
        expect(
            repoWriteRefusal({
                repoPath: REPO,
                cwd: "C:\\Users\\julio\\.orkest\\Tasks\\t_1",
                tool: "Bash",
                args: { command: "Out-File -FilePath D:\\Ware\\Ghost\\x.txt" },
            }),
        ).toBeDefined();
    });
});
