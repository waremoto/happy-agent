import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    UserInputConflictError,
    type NativeToolPermission,
    type UserInputModule,
} from "../../sources/userInput/index.js";
import { nativeToolPermissionQuestion } from "../../sources/userInput/impl/nativeToolPermissionQuestion.js";
import { createUserInputDatabase, createUserInputModule } from "./userInputTestSupport.js";

const AGENT = "agent-one";
const PERMISSION: NativeToolPermission = {
    provider: "claude",
    providerTitle: "Claude Code",
    action: "Write notes.txt",
    input: { file_path: "notes.txt" },
    inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const ANSWER = { approval: "Allow once" };

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
});

/** A native agent's permission question left pending, as `askForNativeToolPermission` raises it. */
async function asking(module: UserInputModule, ctx: Context, permission: NativeToolPermission) {
    const { input, permissionRequest } = nativeToolPermissionQuestion(permission);
    return await module.askForPermission(ctx, AGENT, input, permissionRequest);
}

async function world(name: string, module: UserInputModule = createUserInputModule()) {
    const database = createUserInputDatabase(module, name);
    await database.ready;
    cleanups.push(() => database.close());
    const hooks = module.beforeStart(database.context, {
        parentOf: async () => null,
    } as never);
    return { module, database, ctx: database.context, hooks };
}

describe("native tool question expiry", () => {
    it("refuses an answer that arrives after the deadline, even with no timer left to settle the question", async () => {
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const w = await world("native-expiry-late-answer");
        w.module.setNativeToolQuestionExpiryMs(60_000);
        const stop = new AbortController();
        const allowed = w.module.askForNativeToolPermission(w.ctx, AGENT, PERMISSION, stop.signal);
        let question = (await w.module.list(w.ctx, AGENT, { status: "pending" }))[0];
        while (question === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            question = (await w.module.list(w.ctx, AGENT, { status: "pending" }))[0];
        }
        expect(question.deadlineAt).toBe(61_000);

        // One millisecond past the deadline the real timer has not fired yet; the answer is stale.
        now = 61_001;
        await expect(
            w.module.answer(w.ctx, AGENT, { requestId: question.id, answers: ANSWER }),
        ).rejects.toBeInstanceOf(UserInputConflictError);

        // Stopping the turn ends the wait, and nothing was allowed.
        stop.abort();
        expect(await allowed).toBe(false);
    });

    it("treats the turn as denied when the question expires unanswered", async () => {
        const w = await world("native-expiry-timer");
        w.module.setNativeToolQuestionExpiryMs(300);
        const allowed = await w.module.askForNativeToolPermission(
            w.ctx,
            AGENT,
            PERMISSION,
            new AbortController().signal,
        );
        expect(allowed).toBe(false);
        expect(await w.module.list(w.ctx, AGENT, { status: "pending" })).toEqual([]);
        const [expired] = await w.module.list(w.ctx, AGENT, { status: "terminal" });
        expect(expired?.status).toBe("timed_out");
        // The person answering the expired question changes nothing.
        await expect(
            w.module.answer(w.ctx, AGENT, { requestId: expired!.id, answers: ANSWER }),
        ).rejects.toBeInstanceOf(UserInputConflictError);
    });

    it("still allows an answer inside the deadline", async () => {
        const w = await world("native-expiry-in-time");
        const allowed = w.module.askForNativeToolPermission(
            w.ctx,
            AGENT,
            PERMISSION,
            new AbortController().signal,
        );
        let question = (await w.module.list(w.ctx, AGENT, { status: "pending" }))[0];
        while (question === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            question = (await w.module.list(w.ctx, AGENT, { status: "pending" }))[0];
        }
        await w.module.answer(w.ctx, AGENT, { requestId: question.id, answers: ANSWER });
        expect(await allowed).toBe(true);
    });
});

describe("native tool questions left by an earlier process", () => {
    it("withdraws them at startup so none stays answerable, and spares what the new process asks", async () => {
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const first = await world("native-expiry-restart");
        // The earlier process asked, and died while waiting for the person.
        const asked = await asking(first.module, first.ctx, PERMISSION);

        // A new process over the same store.
        now = 2_000;
        const restarted = createUserInputModule();
        const hooks = restarted.beforeStart(first.ctx, { parentOf: async () => null } as never);
        // What the new process asks once it is running is live, not left over.
        now = 3_000;
        const live = await asking(restarted, first.ctx, {
            ...PERMISSION,
            provider: "codex",
            providerTitle: "Codex",
            action: "Run ls",
            inputDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
        await hooks.afterStart!(first.ctx, {} as never);

        const pending = await restarted.list(first.ctx, AGENT, { status: "pending" });
        expect(pending.map((request) => request.id)).toEqual([live.id]);
        const withdrawn = await restarted.get(first.ctx, AGENT, asked.id);
        expect(withdrawn?.status).toBe("cancelled");
        // Answering it runs nothing: the answer is refused as stale.
        await expect(
            restarted.answer(first.ctx, AGENT, { requestId: asked.id, answers: ANSWER }),
        ).rejects.toBeInstanceOf(UserInputConflictError);
    });

    it("leaves the agent's own questions pending across a restart", async () => {
        const first = await world("native-expiry-restart-own");
        const own = await first.module.ask(
            first.ctx,
            AGENT,
            { question: "Which database?", context: "Needed to proceed." } as never,
            "own-question",
        );
        const restarted = createUserInputModule();
        const hooks = restarted.beforeStart(first.ctx, { parentOf: async () => null } as never);
        await hooks.afterStart!(first.ctx, {} as never);
        const pending = await restarted.list(first.ctx, AGENT, { status: "pending" });
        expect(pending.map((request) => request.id)).toEqual([own.id]);
    });
});

describe("who answered a native tool question", () => {
    it("records the authenticated principal on the answered question", async () => {
        const w = await world("native-expiry-principal");
        const asked = await asking(w.module, w.ctx, PERMISSION);
        const answered = await w.module.answer(
            w.ctx,
            AGENT,
            { requestId: asked.id, answers: ANSWER },
            "user-owner",
        );
        expect(answered).toMatchObject({ status: "answered", answeredBy: "user-owner" });
    });
});
