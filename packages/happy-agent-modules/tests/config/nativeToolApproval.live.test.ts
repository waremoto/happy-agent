import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIVE_HARNESSES, liveNativeAgent, user } from "./support/liveNativeAgent.js";

/**
 * Each native agent, in Read only, is asked to write one file. The file on disk, not the agent's
 * words, decides whether the action ran.
 * Run with HAPPY_NATIVE_APPROVAL_LIVE=1 and `pnpm vitest run --config vitest.live.config.ts`.
 */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WRITE =
    "Create a file named approved.txt in the current folder containing exactly the word ok. " +
    "Use one tool call. If you are not allowed, do not retry another way; reply REFUSED. " +
    "Otherwise reply DONE.";

describe.skipIf(process.env.HAPPY_NATIVE_APPROVAL_LIVE !== "1")(
    "native tool approval, live",
    () => {
        for (const harness of LIVE_HARNESSES) {
            for (const answer of ["Deny", "Allow once"] as const) {
                it(`${harness.title}: Read only, the person answers ${answer}`, async () => {
                    const w = await liveNativeAgent(harness, cleanups);
                    const seen = w.answerAll(answer, "approved.txt");
                    const result = await w.turn("read_only", [user(WRITE)]);
                    const asked = seen.map((question) => question.permissionRequest);
                    const ran = w.exists("approved.txt");
                    console.log(
                        JSON.stringify({
                            harness: harness.model,
                            answer,
                            reply: result.reply.trim().slice(0, 200),
                            events: result.kinds,
                            questions: asked,
                            fileExists: ran,
                            content: ran
                                ? readFileSync(join(w.workspace, "approved.txt"), "utf8").trim()
                                : null,
                        }),
                    );
                    expect(asked.length).toBeGreaterThan(0);
                    for (const request of asked) {
                        expect(request).toMatchObject({
                            source: "native_tool",
                            provider: harness.provider,
                            inputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                        });
                        // The person sees what the action touches, not only a tool name.
                        expect(request?.source === "native_tool" && request.action).toContain(
                            "approved.txt",
                        );
                    }
                    expect(ran).toBe(answer === "Allow once");
                }, 240_000);
            }
        }
    },
);
