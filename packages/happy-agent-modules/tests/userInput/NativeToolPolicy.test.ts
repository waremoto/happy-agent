import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { NativeToolPermission, UserInputModule } from "../../sources/userInput/index.js";
import { createUserInputDatabase, createUserInputModule } from "./userInputTestSupport.js";

// GHO-207.2.3 — a per-agent policy answers a native agent's permission question for the person (harness mode);
// anything it does not allow still reaches the person as a card.

const AGENT = "agent-one";
const OTHER = "agent-two";
const permission = (action: string): NativeToolPermission => ({
    provider: "claude",
    providerTitle: "Claude Code",
    action,
    input: { command: action },
    inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function world(name: string) {
    const module: UserInputModule = createUserInputModule();
    const database = createUserInputDatabase(module, name);
    await database.ready;
    cleanups.push(() => database.close());
    module.beforeStart(database.context, { parentOf: async () => null } as never);
    return { module, ctx: database.context as Context };
}

async function pending(module: UserInputModule, ctx: Context, agentId: string) {
    for (let i = 0; i < 200; i++) {
        const list = await module.list(ctx, agentId, { status: "pending" });
        if (list.length > 0) return list;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return [];
}

describe("native tool policy", () => {
    it("allows what the policy allows without a card", async () => {
        const w = await world("native-policy-allow");
        w.module.setNativeToolPolicy(AGENT, (p) => p.action === "git status");
        const allowed = await w.module.askForNativeToolPermission(
            w.ctx,
            AGENT,
            permission("git status"),
            new AbortController().signal,
        );
        expect(allowed).toBe(true);
        expect(await w.module.list(w.ctx, AGENT, {})).toEqual([]);
    });

    it("asks the person for what the policy does not allow, and for other agents", async () => {
        const w = await world("native-policy-ask");
        w.module.setNativeToolQuestionExpiryMs(60_000);
        w.module.setNativeToolPolicy(AGENT, (p) => p.action === "git status");
        const stop = new AbortController();
        const push = w.module.askForNativeToolPermission(w.ctx, AGENT, permission("git push"), stop.signal);
        const asked = await pending(w.module, w.ctx, AGENT);
        expect(asked).toHaveLength(1);
        await w.module.answer(w.ctx, AGENT, {
            requestId: asked[0]!.id,
            answers: { approval: "Allow once" },
        });
        expect(await push).toBe(true);

        const other = w.module.askForNativeToolPermission(w.ctx, OTHER, permission("git status"), stop.signal);
        expect(await pending(w.module, w.ctx, OTHER)).toHaveLength(1);
        stop.abort();
        expect(await other).toBe(false);
    });

    it("asks again once the policy is cleared, and when the policy throws", async () => {
        const w = await world("native-policy-clear");
        w.module.setNativeToolQuestionExpiryMs(60_000);
        w.module.setNativeToolPolicy(AGENT, () => true);
        w.module.setNativeToolPolicy(AGENT, undefined);
        const stop = new AbortController();
        const cleared = w.module.askForNativeToolPermission(w.ctx, AGENT, permission("git status"), stop.signal);
        expect(await pending(w.module, w.ctx, AGENT)).toHaveLength(1);
        stop.abort();
        expect(await cleared).toBe(false);

        w.module.setNativeToolPolicy(OTHER, () => {
            throw new Error("broken policy");
        });
        const stop2 = new AbortController();
        const thrown = w.module.askForNativeToolPermission(w.ctx, OTHER, permission("git status"), stop2.signal);
        expect(await pending(w.module, w.ctx, OTHER)).toHaveLength(1);
        stop2.abort();
        expect(await thrown).toBe(false);
    });
});
