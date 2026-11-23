import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentSessionIdFor } from "../../sources/orkest/impl/agentSessionId.js";
import { projectSessionPreamble } from "../../sources/orkest/impl/projectSessionPreamble.js";
import {
    baseFor,
    readWorkingCopy,
    refreshStale,
    setBase,
    workingCopyPath,
    writeWorkingCopy,
} from "../../sources/orkest/impl/projectSessionWorkspace.js";

// GHO-196.1.3 — the Happy adapter's working copy, its preamble and the agent session id of a turn.

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function task(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "happy-ps-task-"));
    dirs.push(dir);
    return dir;
}

const ROADMAP =
    "# Roadmap\r\n\nFirst line.\n\n## Next\n\n- one\n- two  \n\n```roadmap\nnodes: []\n```\n";

describe("working copy", () => {
    it("maps docs/ paths into the task folder's doc/ and refuses anything else", async () => {
        const t = await task();
        expect(workingCopyPath(t, "docs/ROADMAP.md")).toBe(join(t, "doc", "ROADMAP.md"));
        expect(workingCopyPath(t, "docs/plans/b.md")).toBe(join(t, "doc", "plans", "b.md"));
        for (const bad of [
            "README.md",
            "docs/../x.md",
            "docs/a.txt",
            "/docs/a.md",
            "docs\\a.md",
            "docs/",
            "docs/.orkest-bases.md",
            "",
        ])
            expect(() => workingCopyPath(t, bad), bad).toThrow(/not a doc path/);
    });

    it("round-trips the text byte for byte and remembers its base", async () => {
        const t = await task();
        expect(await baseFor(t, "docs/ROADMAP.md")).toBeUndefined();
        await writeWorkingCopy(t, "docs/ROADMAP.md", ROADMAP, "a".repeat(40));
        expect(await readFile(join(t, "doc", "ROADMAP.md"), "utf8")).toBe(ROADMAP);
        expect(await readWorkingCopy(t, "docs/ROADMAP.md")).toBe(ROADMAP);
        expect(await baseFor(t, "docs/ROADMAP.md")).toBe("a".repeat(40));
        // A new process reads the same base from disk.
        const raw = JSON.parse(await readFile(join(t, "doc", ".orkest-bases.json"), "utf8"));
        expect(raw).toEqual({ "docs/ROADMAP.md": "a".repeat(40) });
    });

    it("reads a missing copy as undefined and a new doc's base as null", async () => {
        const t = await task();
        expect(await readWorkingCopy(t, "docs/plan-b.md")).toBeUndefined();
        await setBase(t, "docs/plan-b.md", null);
        expect(await baseFor(t, "docs/plan-b.md")).toBeNull();
    });

    it("on a stale base keeps the old copy and writes the current text with its rev", async () => {
        const t = await task();
        await writeWorkingCopy(t, "docs/ROADMAP.md", ROADMAP, "a".repeat(40));
        await writeFile(join(t, "doc", "ROADMAP.md"), `${ROADMAP}\n- my change\n`);
        await refreshStale(t, "docs/ROADMAP.md", "b".repeat(40), "# Roadmap\n\nMoved.\n");
        expect(await readFile(join(t, "doc", ".stale", "ROADMAP.md"), "utf8")).toBe(
            `${ROADMAP}\n- my change\n`,
        );
        expect(await readWorkingCopy(t, "docs/ROADMAP.md")).toBe("# Roadmap\n\nMoved.\n");
        expect(await baseFor(t, "docs/ROADMAP.md")).toBe("b".repeat(40));
    });
});

describe("projectSessionPreamble", () => {
    const scope = { kind: "project" as const, projectId: "p-1", path: null };

    it("tells a project session its focus doc, outline and the tool contract", () => {
        const text = projectSessionPreamble({
            title: "SYN plan review",
            scope,
            permissionMode: "workspace_write",
            focus: { path: "docs/ROADMAP.md", rev: "a".repeat(40), text: ROADMAP },
            docs: 3,
        });
        expect(text).toContain("SYN plan review");
        expect(text).toContain("p-1");
        expect(text).toContain("doc/ROADMAP.md");
        expect(text).toContain("propose_document");
        expect(text).toContain("Next");
        expect(text).toContain("A person reviews every proposal");
        expect(text).not.toContain("propuesta");
    });

    it("works with no docs at all", () => {
        const text = projectSessionPreamble({
            title: "t",
            scope,
            permissionMode: "workspace_write",
            docs: null,
        });
        expect(text).toMatch(/no docs/i);
        expect(text).toContain("list_tickets");
        expect(text).not.toContain("doc/ROADMAP.md");
    });

    it("says a read-only session cannot propose", () => {
        const text = projectSessionPreamble({
            title: "t",
            scope: { kind: "doc", projectId: "p-1", path: "docs/a.md" },
            permissionMode: "read_only",
            focus: { path: "docs/a.md", rev: "c".repeat(40), text: "# A\n" },
            docs: 1,
        });
        expect(text).toMatch(/read only/i);
        expect(text).toContain("docs/a.md");
    });
});

describe("agentSessionIdFor", () => {
    const AGENT = "oa0123456789abcdef01234567";
    async function record(home: string, route: string[], id: string, at: number) {
        const dir = join(home, "foreign-agents", ...route, "sessions");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${encodeURIComponent(AGENT)}.json`);
        await writeFile(path, JSON.stringify({ acpSessionId: id }));
        await utimes(path, at, at);
    }

    it("is undefined with no record", async () => {
        expect(await agentSessionIdFor(await task(), AGENT)).toBeUndefined();
    });

    it("reads the newest record, Claude or Codex", async () => {
        const home = await task();
        await record(home, ["claude_code"], "5b0c6a1e-3f2d-4c8e-9a71-0d2e4f6b8c13", 1_000);
        expect(await agentSessionIdFor(home, AGENT)).toEqual({
            harness: "claude_code",
            id: "5b0c6a1e-3f2d-4c8e-9a71-0d2e4f6b8c13",
        });
        await record(home, ["codex_cli", "codex"], "01a20633-14af-7770-bef5-89738dd8ece3", 2_000);
        expect(await agentSessionIdFor(home, AGENT)).toEqual({
            harness: "codex_cli",
            id: "01a20633-14af-7770-bef5-89738dd8ece3",
        });
    });

    it("ignores an id the commit trailer cannot carry", async () => {
        const home = await task();
        await record(home, ["claude_code"], "has spaces\nand a newline", 1_000);
        expect(await agentSessionIdFor(home, AGENT)).toBeUndefined();
    });
});
