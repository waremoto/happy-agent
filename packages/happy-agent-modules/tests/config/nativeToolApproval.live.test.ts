import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    withAgentConfig,
    withAgentContext,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import { AcpProvider } from "@slopus/happy-providers";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { PresenceModule } from "../../sources/presence/index.js";
import { presenceMigrations } from "../../sources/presence/PresenceDatabase.js";
import {
    UserInputModule,
    userInputMigrations,
    type UserInputRequest,
} from "../../sources/userInput/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

/**
 * The real Claude Code and Codex, signed in as this machine's user (no credentials are configured
 * or copied), each asked to write one file in a disposable folder. The file on disk, not the
 * agent's words, decides whether the action ran. Smallest models, one short turn per test.
 * Run with HAPPY_NATIVE_APPROVAL_LIVE=1 and `pnpm vitest run --config vitest.live.config.ts`.
 */
const HARNESSES = [
    {
        provider: "claude",
        harness: "claude_code",
        model: "claude-code/haiku",
        title: "Claude Code",
    },
    { provider: "codex", harness: "codex_cli", model: "codex-cli/gpt-6.1-terra", title: "Codex" },
] as const;
// Run from inside a Claude Code session, the child Claude would otherwise join that session's host.
for (const name of Object.keys(process.env)) {
    if (/^CLAUDE_(CODE_|AGENT_SDK_|PID$)/.test(name)) delete process.env[name];
}
const AGENT = "agent-live";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(harness: (typeof HARNESSES)[number]) {
    const root = await mkdtemp(join(tmpdir(), "happy-native-approval-live-"));
    cleanups.push(
        async () =>
            await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 }),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const config = await testConfigRootedAt(
        root,
        [
            `[providers.${harness.provider}]`,
            "enabled = true",
            `[harnesses.${harness.harness}]`,
        ].join("\n"),
    );
    const db = moduleDatabase([...presenceMigrations, ...userInputMigrations], "native-live");
    cleanups.push(() => db.close());
    await db.ready;
    const userInput = new UserInputModule(new PresenceModule(config));
    config.useUserInput(userInput);
    const provider = await config.resolveProviderUnchecked(harness.provider, harness.model);
    // Never Happy's own loop on the same account: the native agent itself, or the test is void.
    if (!(provider instanceof AcpProvider)) throw new Error(`${harness.model} is not native.`);
    const session = await provider.session(AGENT, { instructions: "Be brief.", tools: [] });
    cleanups.push(async () => await session.destroy());

    const turnContext = (mode: AgentPermissionMode): Context =>
        withLifetime(
            withAgentConfig(
                withAgentContext(db.context, {
                    id: AGENT,
                    provider: harness.provider,
                    model: harness.model,
                    permissionMode: mode,
                }),
                { modules: { compute: { cwd: workspace } } } as never,
            ),
            new AbortController().signal,
        );

    const target = join(workspace, "approved.txt");
    return {
        target,
        ran: () => existsSync(target),
        async turn(mode: AgentPermissionMode) {
            const kinds = new Map<string, number>();
            let reply = "";
            for await (const event of session.run(turnContext(mode), {
                context: {
                    instructions: "Be brief.",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text:
                                        "Create a file named approved.txt in the current folder " +
                                        "containing exactly the word ok. Use one tool call. If " +
                                        "you are not allowed, do not retry another way; reply " +
                                        "REFUSED. Otherwise reply DONE.",
                                },
                            ],
                        },
                    ],
                },
                model: harness.model,
            })) {
                kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1);
                if (event.type === "done") console.log("done", JSON.stringify(event).slice(0, 600));
                if (event.type === "text_delta") reply += event.delta;
                if (event.type === "done") break;
            }
            return { reply, kinds: Object.fromEntries(kinds) };
        },
        /** Answer every question the turn raises the same way, so a retry is answered too. */
        answerAll(value: string): UserInputRequest[] {
            const seen: UserInputRequest[] = [];
            const tick = setInterval(async () => {
                const pending = await userInput.list(db.context, AGENT, { status: "pending" });
                for (const question of pending) {
                    if (seen.some((s) => s.id === question.id)) continue;
                    seen.push(question);
                    // Pending is not permission: the file must not exist while it waits.
                    if (existsSync(target)) throw new Error("The action ran before an answer.");
                    await userInput.answer(db.context, AGENT, {
                        requestId: question.id,
                        answers: { approval: value },
                    });
                }
            }, 250);
            cleanups.push(() => clearInterval(tick));
            return seen;
        },
    };
}

describe.skipIf(process.env.HAPPY_NATIVE_APPROVAL_LIVE !== "1")(
    "native tool approval, live",
    () => {
        for (const harness of HARNESSES) {
            for (const answer of ["Deny", "Allow once"] as const) {
                it(`${harness.title}: Read only, the person answers ${answer}`, async () => {
                    const w = await world(harness);
                    const seen = w.answerAll(answer);
                    const result = await w.turn("read_only");
                    const asked = seen.map((question) => question.permissionRequest);
                    console.log(
                        JSON.stringify({
                            harness: harness.model,
                            answer,
                            reply: result.reply.trim().slice(0, 200),
                            events: result.kinds,
                            questions: asked,
                            fileExists: w.ran(),
                            content: w.ran() ? readFileSync(w.target, "utf8").trim() : null,
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
                    expect(w.ran()).toBe(answer === "Allow once");
                }, 240_000);
            }
        }
    },
);
