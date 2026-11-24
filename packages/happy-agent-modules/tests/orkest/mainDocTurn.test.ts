import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { OrkestSessionAnswer } from "../../sources/orkest/impl/OrkestSessionClient.js";
import {
    mainDocChangeNote,
    mainDocOpenPath,
    mainDocTurn,
    type MainDocSeen,
} from "../../sources/orkest/impl/projectSessionMainDoc.js";

// GHO-205.3.2 (Orkest design D-46, D-48) — before every turn a project session asks the `focus` session tool for its
// main doc and, when it moved or the person chose another doc, tells the agent what changed and the text now.

const call = { session: "0b6f1a52-6a0e-4f7b-9d39-5f8f0d1c2a11", fence: 3, projectId: "p1" };
const ok = (body: unknown): OrkestSessionAnswer => ({ ok: true, status: 200, body });
const focus = (over: Record<string, unknown> = {}) =>
    ok({
        path: "docs/ROADMAP.md",
        rev: "abc1234",
        text: "# Roadmap\n- one\n",
        changed: false,
        changes: null,
        readOnly: false,
        ...over,
    });

function harness(answer: OrkestSessionAnswer | Error, stored?: MainDocSeen) {
    let seen = stored;
    const asked: Record<string, unknown>[] = [];
    return {
        asked,
        seen: () => seen,
        deps: {
            tool: async (_name: "focus", _call: typeof call, args: Record<string, unknown>) => {
                asked.push(args);
                if (answer instanceof Error) throw answer;
                return answer;
            },
            call,
            read: async () => seen,
            write: async (s: MainDocSeen) => {
                seen = s;
            },
        },
    };
}

describe("the main doc before a turn", () => {
    it("says nothing when the doc did not move, and asks with the revision seen", async () => {
        const h = harness(focus(), { path: "docs/ROADMAP.md", rev: "abc1234" });
        expect(await mainDocTurn(h.deps)).toBeNull();
        expect(h.asked).toEqual([{ since: "abc1234" }]);
    });

    it("tells the agent who changed it and when, with the text now, and remembers the new revision", async () => {
        const h = harness(
            focus({
                rev: "fff9999",
                text: "# Roadmap\n- one\n- two\n",
                changed: true,
                changes: [
                    {
                        sha: "fff9999aaaa",
                        subject: "docs: add two",
                        author: "julio",
                        at: "2026-11-24T18:00:00Z",
                        actor: "person",
                    },
                ],
            }),
            { path: "docs/ROADMAP.md", rev: "abc1234" },
        );
        const note = await mainDocTurn(h.deps);
        expect(note).toContain("The main doc changed: `docs/ROADMAP.md`");
        expect(note).toContain("docs: add two by julio (person) at 2026-11-24T18:00:00Z (fff9999)");
        expect(note).toContain("- two");
        expect(h.seen()).toEqual({ path: "docs/ROADMAP.md", rev: "fff9999" });
    });

    it("names the new doc when the person changed the main doc", async () => {
        const h = harness(focus({ path: "docs/plan.md", rev: "1112223", text: "# Plan\n" }), {
            path: "docs/ROADMAP.md",
            rev: "abc1234",
        });
        expect(await mainDocTurn(h.deps)).toContain(
            "The main doc of this session is now `docs/plan.md` (it was `docs/ROADMAP.md`)",
        );
    });

    it("the first turn only records what it saw", async () => {
        const h = harness(focus());
        expect(await mainDocTurn(h.deps)).toBeNull();
        expect(h.asked).toEqual([{}]);
        expect(h.seen()).toEqual({ path: "docs/ROADMAP.md", rev: "abc1234" });
    });

    it("an older dashboard, a refusal or a seam failure never blocks the turn", async () => {
        const seen = { path: "docs/ROADMAP.md", rev: "abc1234" };
        expect(
            await mainDocTurn(
                harness({ ok: false, status: 404, error: "ORKEST_SESSION_UNKNOWN_TOOL" }, seen)
                    .deps,
            ),
        ).toBeNull();
        expect(await mainDocTurn(harness(new Error("unreachable"), seen).deps)).toBeNull();
    });

    it("says when the person can only read", () => {
        const note = mainDocChangeNote(
            { path: "docs/ROADMAP.md", rev: "a1" },
            {
                path: "docs/ROADMAP.md",
                rev: "b2",
                text: "x",
                changed: true,
                changes: null,
                readOnly: true,
            },
        );
        expect(note).toContain("has a new revision");
        expect(note).toContain("proposals wait for an editor");
    });

    it("opens on the focus answer's doc, else ROADMAP, README, CONTEXT", () => {
        const paths = ["docs/README.md", "docs/CONTEXT.md", "docs/plan.md"];
        expect(mainDocOpenPath(focus({ path: "docs/plan.md" }), paths)).toBe("docs/plan.md");
        expect(mainDocOpenPath(null, paths)).toBe("docs/README.md");
        expect(mainDocOpenPath(null, ["docs/x.md"])).toBeUndefined();
    });

    it("the Orkest module runs it before every turn and the client may call focus", () => {
        const module = readFileSync(
            new URL("../../sources/orkest/OrkestModule.ts", import.meta.url),
            "utf8",
        );
        expect(module).toContain("beforeTurn:");
        expect(module).toContain("mainDocTurn(");
        const client = readFileSync(
            new URL("../../sources/orkest/impl/OrkestSessionClient.ts", import.meta.url),
            "utf8",
        );
        expect(client).toContain('"focus",');
    });
});
