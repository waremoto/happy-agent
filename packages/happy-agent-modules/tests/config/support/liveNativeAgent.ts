import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    withAgentConfig,
    withAgentContext,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import { AcpProvider, type SessionMessage } from "@slopus/happy-providers";
import { withLifetime } from "@steve.kite/stdlib";

import { PresenceModule } from "../../../sources/presence/index.js";
import { presenceMigrations } from "../../../sources/presence/PresenceDatabase.js";
import {
    UserInputModule,
    userInputMigrations,
    type UserInputRequest,
} from "../../../sources/userInput/index.js";
import { testConfigRootedAt } from "../../support/configModule.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";

/**
 * The real Claude Code and Codex, signed in as this machine's user: no credentials are configured
 * or copied. Smallest models; each live test runs a few short turns in a disposable folder.
 */
export const LIVE_HARNESSES = [
    {
        provider: "claude",
        harness: "claude_code",
        model: "claude-code/haiku",
        title: "Claude Code",
    },
    { provider: "codex", harness: "codex_cli", model: "codex-cli/gpt-6.1-terra", title: "Codex" },
] as const;
export type LiveHarness = (typeof LIVE_HARNESSES)[number];

// Run from inside a Claude Code session, the child Claude would otherwise join that session's host.
for (const name of Object.keys(process.env)) {
    if (/^CLAUDE_(CODE_|AGENT_SDK_|PID$)/.test(name)) delete process.env[name];
}

const AGENT = "agent-live";

export interface LiveTurn {
    reply: string;
    kinds: Record<string, number>;
    done: unknown;
}

export const user = (text: string): SessionMessage => ({
    role: "user",
    content: [{ type: "text", text }],
});
export const assistant = (text: string): SessionMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
});

/**
 * One Happy agent on a native harness. `restart` drops the native process and builds the
 * configuration, provider and session again from the same root, as a daemon restart does.
 */
export async function liveNativeAgent(
    harness: LiveHarness,
    cleanups: Array<() => Promise<void> | void>,
) {
    const root = await mkdtemp(join(tmpdir(), "happy-native-live-"));
    cleanups.push(
        async () =>
            await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 }),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const db = moduleDatabase([...presenceMigrations, ...userInputMigrations], "native-live");
    cleanups.push(() => db.close());
    await db.ready;

    async function open() {
        const config = await testConfigRootedAt(
            root,
            [
                `[providers.${harness.provider}]`,
                "enabled = true",
                `[harnesses.${harness.harness}]`,
            ].join("\n"),
        );
        const userInput = new UserInputModule(new PresenceModule(config));
        config.useUserInput(userInput);
        const provider = await config.resolveProviderUnchecked(harness.provider, harness.model);
        // Never Happy's own loop on the same account: the native agent itself, or the test is void.
        if (!(provider instanceof AcpProvider)) throw new Error(`${harness.model} is not native.`);
        const session = await provider.session(AGENT, { instructions: "Be brief.", tools: [] });
        return { userInput, session };
    }

    let current = await open();
    cleanups.push(async () => await current.session.destroy());

    return {
        workspace,
        exists: (name: string) => existsSync(join(workspace, name)),
        async restart(): Promise<void> {
            await current.session.destroy();
            current = await open();
        },
        /** One turn, consumed as Agent Base does; `onEvent` sees each event as it streams. */
        async turn(
            mode: AgentPermissionMode,
            messages: readonly SessionMessage[],
            options: { signal?: AbortSignal; onEvent?: (type: string) => void } = {},
        ): Promise<LiveTurn> {
            const ctx = withLifetime(
                withAgentConfig(
                    withAgentContext(db.context, {
                        id: AGENT,
                        provider: harness.provider,
                        model: harness.model,
                        permissionMode: mode,
                    }),
                    { modules: { compute: { cwd: workspace } } } as never,
                ),
                options.signal ?? new AbortController().signal,
            );
            const kinds = new Map<string, number>();
            let reply = "";
            let done: unknown;
            for await (const event of current.session.run(ctx, {
                context: { instructions: "Be brief.", messages },
                model: harness.model,
            })) {
                kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1);
                options.onEvent?.(event.type);
                if (event.type === "text_delta") reply += event.delta;
                if (event.type === "done") {
                    done = event;
                    break;
                }
            }
            return { reply, kinds: Object.fromEntries(kinds), done };
        },
        /**
         * Answer every question the agent raises the same way, so a retry is answered too.
         * `guard` names a file that must not exist, or returns true once the action ran, while a
         * question waits.
         */
        answerAll(
            value: string | ((question: UserInputRequest) => string),
            guard?: string | (() => boolean),
        ): UserInputRequest[] {
            const seen: UserInputRequest[] = [];
            const tick = setInterval(async () => {
                const { userInput } = current;
                const pending = await userInput.list(db.context, AGENT, { status: "pending" });
                for (const question of pending) {
                    if (seen.some((s) => s.id === question.id)) continue;
                    seen.push(question);
                    // Pending is not permission.
                    const ran =
                        typeof guard === "function"
                            ? guard()
                            : guard !== undefined && existsSync(join(workspace, guard));
                    if (ran) {
                        throw new Error("The action ran before an answer.");
                    }
                    await userInput.answer(db.context, AGENT, {
                        requestId: question.id,
                        answers: {
                            approval: typeof value === "function" ? value(question) : value,
                        },
                    });
                }
            }, 250);
            cleanups.push(() => clearInterval(tick));
            return seen;
        },
    };
}
