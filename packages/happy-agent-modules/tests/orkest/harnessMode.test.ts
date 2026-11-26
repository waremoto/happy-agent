import { describe, expect, it } from "vitest";

import {
    harnessModeAllows,
    harnessModeApplies,
    parseHarnessModeFile,
    starterOf,
} from "../../sources/orkest/impl/harnessMode.js";

// GHO-207.2.3 — a project's harness mode answers in-path, local native tool questions for the owner; the rest still
// reaches the person's card.

const REPO = "D:/work/syn-repo";
const claude = (action: string, input: unknown) =>
    harnessModeAllows(REPO, { provider: "claude", action, input });
const bash = (command: string) => claude(`Bash: ${command}`, { command });
const codexRun = (command: unknown, cwd: string = REPO) =>
    harnessModeAllows(REPO, {
        provider: "codex",
        action: String(command),
        input: { method: "item/commandExecution/requestApproval", command, cwd },
    });
const codexEdit = (...paths: string[]) =>
    harnessModeAllows(REPO, {
        provider: "codex",
        action: `Edit ${paths.join(", ")}`,
        input: {
            method: "item/fileChange/requestApproval",
            changes: paths.map((path) => ({ path, kind: "update" })),
        },
    });

describe("the harness-mode file", () => {
    it("is off when absent, invalid or not enabled", () => {
        expect(parseHarnessModeFile(undefined)).toEqual({ enabled: false });
        expect(parseHarnessModeFile("{").enabled).toBe(false);
        expect(parseHarnessModeFile('{"schema":2,"enabled":true}').enabled).toBe(false);
        expect(parseHarnessModeFile('{"schema":1}').enabled).toBe(false);
        expect(parseHarnessModeFile('{"schema":1,"enabled":true,"owners":[]}').enabled).toBe(false);
        expect(parseHarnessModeFile('{"schema":1,"enabled":true,"owners":["nobody"]}').problem).toMatch(
            /provider:id/,
        );
    });
    it("is on with schema 1 and enabled, with optional owners", () => {
        expect(parseHarnessModeFile('{"schema":1,"enabled":true}')).toEqual({ enabled: true });
        expect(
            parseHarnessModeFile('{"schema":1,"enabled":true,"owners":["ghostshell:e2e"]}'),
        ).toEqual({ enabled: true, owners: ["ghostshell:e2e"] });
    });
    it("applies to a workspace_write session a listed person started", () => {
        const file = parseHarnessModeFile('{"schema":1,"enabled":true,"owners":["ghostshell:e2e"]}');
        const started = { provider: "ghostshell", id: "e2e" };
        expect(starterOf(started)).toBe("ghostshell:e2e");
        expect(starterOf({ Provider: "ghostshell", Id: "e2e" })).toBe("ghostshell:e2e");
        expect(harnessModeApplies({ file, permissionMode: "workspace_write", startedBy: started })).toBe(true);
        expect(harnessModeApplies({ file, permissionMode: "read_only", startedBy: started })).toBe(false);
        expect(
            harnessModeApplies({
                file,
                permissionMode: "workspace_write",
                startedBy: { provider: "ghostshell", id: "someone-else" },
            }),
        ).toBe(false);
        expect(harnessModeApplies({ file, permissionMode: "workspace_write", startedBy: null })).toBe(false);
        const anyone = parseHarnessModeFile('{"schema":1,"enabled":true}');
        expect(
            harnessModeApplies({ file: anyone, permissionMode: "workspace_write", startedBy: started }),
        ).toBe(true);
    });
});

describe("Claude Code questions under harness mode", () => {
    it("allows in-path reads, writes and local tools", () => {
        expect(claude("Read: D:/work/syn-repo/README.md", { file_path: "D:/work/syn-repo/README.md" })).toBe(true);
        expect(claude("Edit: README.md", { file_path: "README.md", old_string: "a", new_string: "b" })).toBe(true);
        expect(claude("Write: d:\\work\\syn-repo\\docs\\ROADMAP.md", { file_path: "d:\\work\\syn-repo\\docs\\ROADMAP.md" })).toBe(true);
        expect(claude("Grep: TODO", { pattern: "TODO" })).toBe(true);
        expect(claude("Skill", { skill: "ork" })).toBe(true);
        expect(claude("TodoWrite", { todos: [] })).toBe(true);
    });
    it("asks for anything outside the path, secrets, git internals and the harness-mode file", () => {
        expect(claude("Edit: D:/work/other/README.md", { file_path: "D:/work/other/README.md" })).toBe(false);
        expect(claude("Write: ../escape.txt", { file_path: "../escape.txt" })).toBe(false);
        expect(claude("Read: C:/Users/me/.ssh/id_rsa", { file_path: "C:/Users/me/.ssh/id_rsa" })).toBe(false);
        expect(claude("Read: .env", { file_path: ".env" })).toBe(false);
        expect(claude("Edit: .env.local", { file_path: ".env.local" })).toBe(false);
        expect(claude("Write: .git/config", { file_path: ".git/config" })).toBe(false);
        expect(claude("Write: .orkest/harness-mode.json", { file_path: ".orkest/harness-mode.json" })).toBe(false);
        expect(claude("WebFetch: https://example.com", { url: "https://example.com" })).toBe(false);
        expect(claude("mcp__github__create_issue", {})).toBe(false);
        expect(claude("SomethingNew", {})).toBe(false);
    });
    it("allows local commands, tests and commits in the repository", () => {
        expect(bash("git status")).toBe(true);
        expect(bash("git add notes/a.txt && git commit -m 'add a note'")).toBe(true);
        expect(bash("mkdir -p notes && echo hi > notes/a.txt")).toBe(true);
        expect(bash("py -3.12 bin/orkest.py doctor --repo . 2>&1 | tail -5")).toBe(true);
        expect(bash("npx --no-install vitest run tests/a.test.ts")).toBe(true);
        expect(bash("pwsh -NoProfile -Command \"git log --oneline -3\"")).toBe(true);
        expect(bash("make test")).toBe(true);
        expect(bash("cd docs && ls")).toBe(true);
    });
    it("asks for push, remote git, deploys, network, installs and hidden commands", () => {
        expect(bash("git push origin main")).toBe(false);
        expect(bash("git add -A && git commit -m x && git push")).toBe(false);
        expect(bash("git fetch")).toBe(false);
        expect(bash("git remote add o https://x")).toBe(false);
        expect(bash("git reset --hard HEAD~1")).toBe(false);
        expect(bash("git commit --amend -m x")).toBe(false);
        expect(bash("git -C D:/work/other status")).toBe(false);
        expect(bash("make -C D:/ware/Ghost dash-deploy REF=origin/develop")).toBe(false);
        expect(bash("make deploy")).toBe(false);
        expect(bash("docker compose up -d")).toBe(false);
        expect(bash("curl -X POST https://example.com")).toBe(false);
        expect(bash("Invoke-WebRequest https://example.com")).toBe(false);
        expect(bash("gh pr create")).toBe(false);
        expect(bash("npm install left-pad")).toBe(false);
        expect(bash("npx vitest run")).toBe(false);
        expect(bash("cat .env")).toBe(false);
        expect(bash("echo $(cat secrets) > out.txt")).toBe(false);
        expect(bash("echo hi > D:/work/other/x.txt")).toBe(false);
        expect(bash("cd .. && rm -rf syn-repo")).toBe(false);
        expect(bash("rm -rf C:/Windows")).toBe(false);
        expect(bash("bash -c 'git push'")).toBe(false);
        expect(bash("echo on > .orkest/harness-mode.json")).toBe(false);
    });
});

describe("Codex questions under harness mode", () => {
    it("allows in-path commands and file changes", () => {
        expect(codexRun("git status")).toBe(true);
        expect(codexRun(["git", "commit", "-m", "a note"])).toBe(true);
        expect(codexRun('"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "git add notes/a.txt"')).toBe(true);
        expect(codexEdit("D:/work/syn-repo/notes/a.txt", "README.md")).toBe(true);
    });
    it("asks outside the path and for push or network", () => {
        expect(codexRun("git status", "D:/work/other")).toBe(false);
        expect(codexRun("git push")).toBe(false);
        expect(codexRun(["curl", "https://example.com"])).toBe(false);
        expect(codexEdit("D:/work/other/a.txt")).toBe(false);
        expect(codexEdit()).toBe(false);
        expect(
            harnessModeAllows(REPO, {
                provider: "codex",
                action: "something",
                input: { method: "item/permissions/requestApproval" },
            }),
        ).toBe(false);
    });
});
