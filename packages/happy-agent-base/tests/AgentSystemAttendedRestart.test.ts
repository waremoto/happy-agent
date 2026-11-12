import { Type } from "@sinclair/typebox";
import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    AgentStorage,
    AgentSystemLocal,
    defineAgentTool,
    type AgentModule,
    type AgentModuleHooks,
    type AgentStorageLock,
} from "../sources/index.js";
import { databaseBackends, type TestDatabase } from "./gym/databaseBackends.js";
import { inMemoryStorageLock, providersOf, textTurn, user } from "./gym/fixtures.js";

/*
 * An attended installation never acts without a person asking. A run a restart cut off while a
 * durable tool call was in flight used to resume by itself and execute that call again. With
 * `resumeInterruptedRuns: false` nothing runs until a person's message arrives, and even then
 * the interrupted call is answered as not run instead of executing.
 */

const ctx = createRootContext().named("agent-system-attended-restart-test");
const AGENT = "subject";

vi.setConfig({ testTimeout: 60_000 });

/** "go" asks for the durable tool; anything else is answered in text. */
class ScriptedProvider extends BaseProvider {
    static override readonly name = "attended-restart-scripted";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];
    requests = 0;

    session(id: string, _options: SessionOptions): Promise<BaseSession> {
        return Promise.resolve(new ScriptedSession(id, this));
    }
}

class ScriptedSession extends BaseSession {
    readonly #provider: ScriptedProvider;

    constructor(id: string, provider: ScriptedProvider) {
        super(id);
        this.#provider = provider;
    }

    run(_ctx: Context, request: SessionRunRequest): SessionStream {
        this.#provider.requests += 1;
        const last = request.context.messages.at(-1);
        const said =
            last?.role === "user"
                ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
                : "";
        const batch: SessionEvent[] =
            said === "go"
                ? [
                      { type: "toolcall_start", callId: "call-a", name: "durable_work" },
                      { type: "toolcall_end", callId: "call-a", arguments: "{}" },
                      { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
                  ]
                : textTurn("ok");
        return (async function* (): AsyncGenerator<SessionEvent> {
            yield* batch;
        })();
    }

    compact(): never {
        throw new Error("not used");
    }

    destroy(): void {}
}

/** A module offering one durable tool that counts every execution and, if told to, hangs. */
class DurableWork implements AgentModule {
    readonly name = "durable-work";
    executions = 0;
    #hang: boolean;
    #release: (() => void) | undefined;

    constructor(hang: boolean) {
        this.#hang = hang;
    }

    /** Lets the hung call of a process that was "killed" finish, so the test can clean up. */
    release(): void {
        this.#release?.();
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        tools: () => [
            defineAgentTool({
                name: "durable_work",
                durable: true,
                returnType: Type.Object({}),
                shouldReviewInAutoMode: () => false,
                execute: async () => {
                    this.executions += 1;
                    if (this.#hang) {
                        this.#hang = false;
                        await new Promise<void>((resolve) => {
                            this.#release = resolve;
                        });
                    }
                    return {};
                },
                toLLM: () => [{ type: "text", text: "done" }],
            }),
        ],
    });
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** A first process killed with a durable tool call in flight, then a second over its store. */
async function restarted(
    open: () => Promise<TestDatabase>,
    options: { readonly resumeInterruptedRuns?: boolean },
    test: (second: {
        readonly system: AgentSystemLocal;
        readonly provider: ScriptedProvider;
        readonly work: DurableWork;
        readonly executionsBeforeRestart: number;
    }) => Promise<void>,
): Promise<void> {
    const opened = await open();
    const provider = new ScriptedProvider();
    let lock: (ctx: Context) => Promise<AgentStorageLock> = inMemoryStorageLock();
    const start = async (work: DurableWork, extra: object): Promise<AgentSystemLocal> =>
        await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock, database: opened.database }),
            {
                modules: [work],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
                ...extra,
            },
        );
    try {
        const firstWork = new DurableWork(true);
        const first = await start(firstWork, {});
        const agent = await first.create(ctx, {}, { id: AGENT });
        await agent.send(ctx, user("go"));
        await until(() => firstWork.executions === 1);
        // The process dies here: the call is durable, in flight, and has no result.
        lock = inMemoryStorageLock();

        const work = new DurableWork(false);
        const second = await start(work, options);
        await test({
            system: second,
            provider,
            work,
            executionsBeforeRestart: firstWork.executions,
        });
        await second.close(ctx);
        firstWork.release();
        await first.close(ctx).catch(() => undefined);
    } finally {
        await opened.close();
    }
}

describe.each(databaseBackends)("attended restart ($label)", ({ open }) => {
    it("does not execute an interrupted durable tool call until a person sends a message", async () => {
        await restarted(open, { resumeInterruptedRuns: false }, async (second) => {
            const requestsAtStart = second.provider.requests;
            // Resolving the agent, as any read or delivery path does, must not start its run.
            const agent = await second.system.resolve(ctx, AGENT);
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(second.work.executions).toBe(0);
            expect(second.provider.requests).toBe(requestsAtStart);

            // A person's message continues the conversation; the interrupted call is answered as
            // not run, and still nothing executes.
            await agent.send(ctx, user("hello"));
            await agent.waitForIdle();
            expect(second.work.executions).toBe(0);
            expect(second.provider.requests).toBeGreaterThan(requestsAtStart);
        });
    });

    it("control: an unattended installation resumes and executes it again by itself", async () => {
        await restarted(open, {}, async (second) => {
            const agent = await second.system.resolve(ctx, AGENT);
            await agent.waitForIdle();
            await until(() => second.work.executions === 1);
            expect(second.work.executions).toBe(1);
        });
    });
});
