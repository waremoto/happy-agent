import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIVE_HARNESSES, liveNativeAgent, user } from "./support/liveNativeAgent.js";

/**
 * Each native agent, in Read only, is asked to change one existing file. The question the person
 * sees must name the file and show the change; the bytes on disk, not the agent's words, decide
 * whether it ran, and the file must stay untouched while the question is pending.
 * Run with HAPPY_NATIVE_APPROVAL_LIVE=1 and `pnpm vitest run --config vitest.live.config.ts`.
 */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const EDIT =
    "Change the contents of notes.txt in the current folder from alpha to beta. " +
    "Use the fewest tool calls. If you are not allowed, do not retry another way; reply REFUSED. " +
    "Otherwise reply DONE.";
// Codex edits through a shell command unless told to patch; the file change is what is under test.
const CODEX_PATCH = " Edit the file with your apply_patch file-editing tool, not a shell command.";

describe.skipIf(process.env.HAPPY_NATIVE_APPROVAL_LIVE !== "1")(
    "native file edit approval, live",
    () => {
        for (const harness of LIVE_HARNESSES) {
            for (const answer of ["Deny", "Allow once"] as const) {
                it(`${harness.title}: Read only, an edit of notes.txt, the person answers ${answer}`, async () => {
                    const w = await liveNativeAgent(harness, cleanups);
                    const file = join(w.workspace, "notes.txt");
                    const original = Buffer.from("alpha");
                    writeFileSync(file, original);
                    // Pending is not permission: the file must still be the original at every question.
                    // Reading the file first is harmless and allowed; the answer under test is for the edit.
                    const given: string[] = [];
                    const seen = w.answerAll(
                        (question) => {
                            const action =
                                question.permissionRequest?.source === "native_tool"
                                    ? question.permissionRequest.action
                                    : "";
                            const value = /^Read/.test(action) ? "Allow once" : answer;
                            given.push(`${value} <- ${action}`);
                            return value;
                        },
                        () => !readFileSync(file).equals(original),
                    );
                    const prompt = harness.provider === "codex" ? EDIT + CODEX_PATCH : EDIT;
                    const result = await w.turn("read_only", [user(prompt)]);
                    const after = readFileSync(file);
                    const questions = seen.map((question) => ({
                        question:
                            question.questions?.[0]?.question ?? question.question ?? undefined,
                        context: question.context,
                        permissionRequest: question.permissionRequest,
                    }));
                    console.log(
                        JSON.stringify({
                            harness: harness.model,
                            answer,
                            reply: result.reply.trim().slice(0, 200),
                            questions,
                            given,
                            bytesAfter: after.toString("hex"),
                            textAfter: after.toString("utf8"),
                        }),
                    );
                    const edit = seen.find(
                        (question) =>
                            question.permissionRequest?.source === "native_tool" &&
                            !/^Read:/.test(question.permissionRequest.action),
                    );
                    expect(edit, "a question about the edit itself").toBeDefined();
                    const request = edit?.permissionRequest;
                    expect(request).toMatchObject({
                        source: "native_tool",
                        provider: harness.provider,
                        inputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                    });
                    // The person sees the path and what it changes, not only a tool name.
                    expect(request?.source === "native_tool" && request.action).toContain(
                        "notes.txt",
                    );
                    const shown = `${edit?.context ?? ""}`;
                    expect(shown).toContain("notes.txt");
                    expect(shown).toContain("beta");
                    // The file, independently of any text above.
                    if (answer === "Deny") expect(after.equals(original)).toBe(true);
                    else expect(after.toString("utf8").trim()).toBe("beta");
                }, 300_000);
            }
        }
    },
);
