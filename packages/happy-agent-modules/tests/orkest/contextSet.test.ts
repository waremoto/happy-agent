import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
    OrkestSessionAnswer,
    OrkestSessionCall,
    OrkestSessionClient,
} from "../../sources/orkest/impl/OrkestSessionClient.js";
import { contextSection, contextSetOf } from "../../sources/orkest/impl/projectSessionContext.js";
import {
    openProjectSession,
    type ProjectSessionState,
} from "../../sources/orkest/impl/projectSessionOpen.js";
import { projectSessionPreamble } from "../../sources/orkest/impl/projectSessionPreamble.js";

// GHO-205.6.1 (Orkest design § 8, D-42) — at open the session asks `focus` for the context set too, and its
// instructions carry the set: the project files first, the main doc last, each as the dashboard cut it.

const ok = (body: unknown): OrkestSessionAnswer => ({ ok: true, status: 200, body });
const PROJECT = "11111111-1111-4111-8111-111111111111";
const call = { workerToken: "t", runId: "r", fence: 1 } as unknown as OrkestSessionCall;
const context = {
    source: "default",
    invalid: false,
    files: [
        { path: "docs/ROADMAP.md", role: "main", chars: 3, truncated: false, text: "# R" },
        { path: "AGENTS.md", role: "project", chars: 5, truncated: true, text: "agent[cut]" },
    ],
};

let dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
});

describe("GHO-205.6.1 the context set", () => {
    it("reads the set from a focus answer, and nothing from a refusal or an older dashboard", () => {
        expect(contextSetOf(ok({ path: "docs/ROADMAP.md", context }))).toEqual([
            { path: "docs/ROADMAP.md", role: "main", truncated: false, text: "# R" },
            { path: "AGENTS.md", role: "project", truncated: true, text: "agent[cut]" },
        ]);
        expect(contextSetOf(ok({ path: "docs/ROADMAP.md" }))).toBeNull();
        expect(
            contextSetOf({ ok: false, status: 404, error: "ORKEST_SESSION_UNKNOWN_TOOL" }),
        ).toBeNull();
        expect(contextSetOf(null)).toBeNull();
    });

    it("puts the project files first and the main doc last in the instructions", () => {
        const files = contextSetOf(ok({ context }))!;
        const section = contextSection(files);
        expect(
            section.indexOf(
                '<context-file path="AGENTS.md" note="cut, read the file for the rest">',
            ),
        ).toBeGreaterThan(0);
        expect(
            section.indexOf('<context-file path="docs/ROADMAP.md" note="main doc">'),
        ).toBeGreaterThan(section.indexOf('AGENTS.md"'));
        expect(section).toContain("Context chip): AGENTS.md, docs/ROADMAP.md.");
        expect(contextSection([])).toBe("");
        const preamble = projectSessionPreamble({
            title: "Orkest",
            scope: { kind: "project", projectId: PROJECT, path: null },
            permissionMode: "workspace_write",
            docs: 1,
            context: files,
        });
        expect(preamble).toContain('<context-file path="AGENTS.md"');
        expect(preamble).toContain("# R");
    });

    it("asks focus for the context at open and keeps it on the session", async () => {
        const taskPath = await mkdtemp(join(tmpdir(), "orkest-ctx-"));
        dirs.push(taskPath);
        const asked: { name: string; args: Record<string, unknown> }[] = [];
        const client = {
            tool: async (name: string, _call: OrkestSessionCall, args: Record<string, unknown>) => {
                asked.push({ name, args });
                if (name === "list_docs")
                    return ok({ docs: [{ path: "docs/ROADMAP.md" }], repo: { repo: "r1" } });
                if (name === "focus")
                    return ok({
                        path: "docs/ROADMAP.md",
                        rev: "a".repeat(40),
                        text: "# R",
                        context,
                    });
                if (name === "read_doc")
                    return ok({ path: "docs/ROADMAP.md", rev: "a".repeat(40), text: "# R" });
                return { ok: false, status: 404, error: "no" } as OrkestSessionAnswer;
            },
        } as unknown as OrkestSessionClient;
        const state: ProjectSessionState = {
            scope: { kind: "project", projectId: PROJECT, path: null },
            title: "Orkest",
            permissionMode: "workspace_write",
            taskPath,
            repoPath: null,
            docs: null,
        };
        expect(await openProjectSession(client, call, state)).toBeUndefined();
        expect(asked.find((a) => a.name === "focus")?.args).toEqual({ context: true });
        expect(state.context?.map((f) => f.path)).toEqual(["docs/ROADMAP.md", "AGENTS.md"]);
        expect(state.focus?.path).toBe("docs/ROADMAP.md");
    });
});
