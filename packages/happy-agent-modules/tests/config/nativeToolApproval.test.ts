import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    withAgentConfig,
    withAgentContext,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import type { AcpProvider } from "@slopus/happy-providers";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { PresenceModule } from "../../sources/presence/index.js";
import { presenceMigrations } from "../../sources/presence/PresenceDatabase.js";
import {
    UserInputConflictError,
    UserInputModule,
    userInputMigrations,
    type UserInputRequest,
} from "../../sources/userInput/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const SERVER = fileURLToPath(new URL("./fixtures/approvingCodexAppServer.mjs", import.meta.url));
const AGENT = "agent-a";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A Happy agent running Codex CLI through the real configuration path, with the real question
 * module. Codex is a scripted app server: its one action creates outside.txt only when accepted,
 * so the file is independent proof of whether the action ran.
 */
async function world() {
    const root = await mkdtemp(join(tmpdir(), "happy-native-approval-"));
    // A stopped agent process can hold its folder open briefly on Windows.
    cleanups.push(
        async () =>
            await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 }),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const approvalLog = join(root, "approval.log");
    const config = await testConfigRootedAt(
        root,
        [
            "[providers.codex]",
            "enabled = true",
            "[harnesses.codex_cli]",
            `command = ${JSON.stringify(process.execPath)}`,
            `args = ${JSON.stringify([SERVER])}`,
            `env = { APPROVAL_LOG = ${JSON.stringify(approvalLog)} }`,
        ].join("\n"),
    );
    const db = moduleDatabase([...presenceMigrations, ...userInputMigrations], "native-approval");
    cleanups.push(() => db.close());
    await db.ready;
    const userInput = new UserInputModule(new PresenceModule(config));
    config.useUserInput(userInput);
    const provider = (await config.resolveProviderUnchecked(
        "codex",
        "codex-cli/gpt-6.1-sol",
    )) as AcpProvider;
    const session = await provider.session(AGENT, { instructions: "Be Happy.", tools: [] });
    cleanups.push(async () => await session.destroy());

    const turnContext = (mode: AgentPermissionMode, lifetime: AbortSignal): Context =>
        withLifetime(
            withAgentConfig(
                withAgentContext(db.context, {
                    id: AGENT,
                    provider: "codex",
                    model: "codex-cli/gpt-6.1-sol",
                    permissionMode: mode,
                }),
                { modules: { compute: { cwd: workspace } } } as never,
            ),
            lifetime,
        );

    return {
        ctx: db.context,
        session,
        userInput,
        ran: () => existsSync(join(workspace, "outside.txt")),
        policies: () => readFileSync(approvalLog, "utf8").trim().split("\n"),
        workspace,
        /** One turn, consumed as Agent Base does; resolves with the agent's text. */
        async turn(
            text: string,
            mode: AgentPermissionMode,
            lifetime = new AbortController().signal,
        ): Promise<string> {
            let reply = "";
            for await (const event of session.run(turnContext(mode, lifetime), {
                context: {
                    instructions: "Be Happy.",
                    messages: [{ role: "user", content: [{ type: "text", text }] }],
                },
                model: "codex-cli/gpt-6.1-sol",
            })) {
                if (event.type === "text_delta") reply += event.delta;
                if (event.type === "done") break;
            }
            return reply;
        },
        async pendingQuestion(): Promise<UserInputRequest> {
            let found: UserInputRequest | undefined;
            await expect
                .poll(
                    async () => {
                        found = (await userInput.list(db.context, AGENT, { status: "pending" }))[0];
                        return found !== undefined;
                    },
                    { timeout: 15_000 },
                )
                .toBe(true);
            return found!;
        },
        async answer(question: UserInputRequest, value: string): Promise<UserInputRequest> {
            return await userInput.answer(db.context, AGENT, {
                requestId: question.id,
                answers: { approval: value },
            });
        },
    };
}

function digestOf(cwd: string): string {
    // The exact input Codex sent, keys sorted, as the person approves it.
    const input = {
        command: "touch outside.txt",
        cwd,
        method: "item/commandExecution/requestApproval",
        reason: "Needs to write outside the sandbox",
    };
    return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

describe("native tool approval", () => {
    it("asks the person about a Read only action, holds it while pending, and runs it once on Allow once", async () => {
        const w = await world();
        const turn = w.turn("please touch it", "read_only");
        const question = await w.pendingQuestion();

        expect(question.permissionRequest).toEqual({
            source: "native_tool",
            provider: "codex",
            providerTitle: "Codex",
            action: "touch outside.txt",
            inputDigest: digestOf(w.workspace),
        });
        expect(question.questions).toEqual([
            expect.objectContaining({
                id: "approval",
                header: "Permission",
                question: "Codex wants to: touch outside.txt",
            }),
        ]);
        expect(question.context).toContain('"command": "touch outside.txt"');
        // Pending is not permission: nothing ran while the person had not answered.
        expect(w.ran()).toBe(false);

        await w.answer(question, "Allow once");
        expect(await turn).toBe("ran");
        expect(w.ran()).toBe(true);
        // Codex was allowed to ask at all only because a person answers.
        expect(w.policies()).toEqual(["on-request"]);
        // First answer wins; a second, stale answer is refused.
        await expect(w.answer(question, "Deny")).rejects.toBeInstanceOf(UserInputConflictError);
    }, 60_000);

    it("never runs a Workspace write action the person denies", async () => {
        const w = await world();
        const turn = w.turn("please touch it", "workspace_write");
        await w.answer(await w.pendingQuestion(), "Deny");
        expect(await turn).toBe("declined");
        expect(w.ran()).toBe(false);
    }, 60_000);

    it("treats a free-text answer as a denial", async () => {
        const w = await world();
        const turn = w.turn("please touch it", "read_only");
        await w.answer(await w.pendingQuestion(), "sure, go ahead");
        expect(await turn).toBe("declined");
        expect(w.ran()).toBe(false);
    }, 60_000);

    it("withdraws the question and refuses the action when the turn stops", async () => {
        const w = await world();
        const stop = new AbortController();
        const turn = w.turn("please touch it", "read_only", stop.signal);
        const question = await w.pendingQuestion();
        stop.abort();
        await turn;
        await expect
            .poll(async () => (await w.userInput.list(w.ctx, AGENT, { status: "pending" })).length)
            .toBe(0);
        // A late answer to the withdrawn question cannot revive the action.
        await expect(w.answer(question, "Allow once")).rejects.toBeInstanceOf(
            UserInputConflictError,
        );
        expect(w.ran()).toBe(false);
    }, 60_000);

    it("runs nothing when the agent process is gone before the person answers, as after a restart", async () => {
        const w = await world();
        const turn = w.turn("please touch it", "read_only").catch(() => "stopped");
        const question = await w.pendingQuestion();
        // A daemon restart takes the native agent process, and the request it was holding, with it.
        await w.session.destroy();
        await turn;
        await w.answer(question, "Allow once").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(w.ran()).toBe(false);
    }, 60_000);

    it("leaves Auto to its own policy: Codex is not invited to ask, and nobody is asked", async () => {
        const w = await world();
        expect(await w.turn("please touch it", "auto")).toBe("ran");
        expect(w.policies()).toEqual(["never"]);
        expect(await w.userInput.list(w.ctx, AGENT, { status: "pending" })).toEqual([]);
    }, 60_000);
});
