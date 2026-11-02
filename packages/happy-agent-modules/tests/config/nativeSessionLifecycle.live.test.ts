import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    LIVE_HARNESSES,
    assistant,
    liveNativeAgent,
    user,
    type LiveHarness,
} from "./support/liveNativeAgent.js";

/**
 * A native agent's session across a seeded transcript, a process restart and a stop. Each marker
 * lives in exactly one place, so recalling it proves where the agent got it: the seeded history,
 * the native thread that survived a restart, or nothing at all.
 * Run with HAPPY_NATIVE_APPROVAL_LIVE=1 and `pnpm vitest run --config vitest.live.config.ts`.
 */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const marker = (prefix: string) => `${prefix}${randomBytes(4).toString("hex").toUpperCase()}`;

/** A command that creates its file only after a delay long enough to stop it first. */
function slowWrite(harness: LiveHarness): string {
    return harness.provider === "codex"
        ? "Start-Sleep -Seconds 20; Set-Content -Path stopped.txt -Value ok"
        : "sleep 20 && echo ok > stopped.txt";
}

describe.skipIf(process.env.HAPPY_NATIVE_APPROVAL_LIVE !== "1")(
    "native session lifecycle, live",
    () => {
        for (const harness of LIVE_HARNESSES) {
            it(`${harness.title}: answers from a seeded transcript it never saw live`, async () => {
                const w = await liveNativeAgent(harness, cleanups);
                w.answerAll("Deny");
                const seed = marker("SEED");
                const result = await w.turn("read_only", [
                    user(`Remember this seed word: ${seed}. Reply only OK.`),
                    assistant("OK"),
                    user("What is the seed word? Reply with the word only."),
                ]);
                console.log(JSON.stringify({ harness: harness.model, seed, ...result }));
                expect(result.reply).toContain(seed);
            }, 240_000);

            it(`${harness.title}: continues its own thread after a process restart`, async () => {
                const w = await liveNativeAgent(harness, cleanups);
                // Claude asks before reading in Read only; the read is what this test needs.
                const seen = w.answerAll("Allow once");
                // Only in a file the agent reads once, then deleted: never in Happy's history.
                const secret = marker("NATIVE");
                await writeFile(join(w.workspace, "marker.txt"), secret);
                const first = user(
                    "Read marker.txt in the current folder with one tool call and remember its " +
                        "content. Do not repeat it. Reply only OK.",
                );
                const before = await w.turn("read_only", [first]);
                expect(before.reply).not.toContain(secret);
                expect(before.kinds["toolcall_result_end"]).toBeGreaterThan(0);
                for (const question of seen) {
                    const request = question.permissionRequest;
                    // Only the read was allowed: nothing that writes was asked for.
                    expect(request?.source === "native_tool" && request.action).toContain(
                        "marker.txt",
                    );
                }
                await rm(join(w.workspace, "marker.txt"));

                await w.restart();
                const after = await w.turn("read_only", [
                    first,
                    assistant("OK"),
                    user(
                        "marker.txt is gone. From memory, what was its content? Reply with the " +
                            "content only, or UNKNOWN.",
                    ),
                ]);
                console.log(
                    JSON.stringify({ harness: harness.model, secret, before, after: after }),
                );
                // A replay of Happy's history could not contain it: the thread itself continued.
                expect(after.reply).toContain(secret);
            }, 300_000);

            it(`${harness.title}: a stopped turn runs nothing more, and the next turn works`, async () => {
                const w = await liveNativeAgent(harness, cleanups);
                const seen = w.answerAll("Allow once");
                const stop = new AbortController();
                let started = 0;
                let abortedAt = 0;
                const ask = user(
                    `Run this exact shell command once, in the current folder: ${slowWrite(harness)}` +
                        " Then reply DONE.",
                );
                const stopped = w.turn("workspace_write", [ask], {
                    signal: stop.signal,
                    onEvent: (type) => {
                        if (type === "toolcall_start" && started++ === 0) {
                            setTimeout(() => {
                                abortedAt = Date.now();
                                stop.abort();
                            }, 3_000);
                        }
                    },
                });
                const result = await stopped.catch((error: unknown) => ({
                    reply: "",
                    kinds: {},
                    done: { error: String(error) },
                }));
                const endedAfterStopMs = Date.now() - abortedAt;
                expect(started).toBeGreaterThan(0);
                // Long past the command's delay: had it kept running, the file would exist.
                await new Promise((resolve) => setTimeout(resolve, 30_000));
                const ranAfterStop = w.exists("stopped.txt");

                const next = await w.turn("workspace_write", [
                    ask,
                    assistant("Stopped."),
                    user("Reply only PONG."),
                ]);
                console.log(
                    JSON.stringify({
                        harness: harness.model,
                        questions: seen.map((question) => question.permissionRequest),
                        stopped: result,
                        endedAfterStopMs,
                        ranAfterStop,
                        next,
                    }),
                );
                expect(ranAfterStop).toBe(false);
                expect(next.reply).toContain("PONG");
            }, 300_000);
        }
    },
);
