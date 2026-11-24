import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { withAgentDatabase } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { derivedId } from "../../sources/orkest/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";

// GHO-205.1.2 (design R5, D-49): one session type is enough for research because a project session can search the
// web. Ghost's scripts/orkest-project-session-happy-real.mjs (HAPPY_REAL_TEST names this file) registers a
// HappyAttended worker for afk-probe, starts one `happy` project session (harness claude) as a person and writes the
// spec; this file runs the real Happy runtime on the machine's own Claude Code sign-in, asks a question only the web
// answers well, and passes only when a web tool ran and the reply carries a URL. Skipped unless ORKEST_REAL_SPEC
// names the spec.
//   npx vitest run --config vitest.live.config.ts tests/orkest/webSearch.live.test.ts

interface RealSpec {
    readonly fatherUrl: string;
    readonly sessionUrl: string;
    readonly agencyTokenFile: string;
    readonly workerTokenFile: string;
    readonly workerId: string;
    readonly tag: string;
    readonly run: { readonly runId: string; readonly projectId: string };
    readonly resultFile: string;
}

const SPEC = process.env.ORKEST_REAL_SPEC;
const MODE = {
    providerId: "claude",
    modelId: "claude-code/sonnet",
    effort: "medium",
    serviceTier: null,
    permissionMode: "read_only",
} as const;
/** The web tools a project session may use: Claude Code's own, or the provider's server tool. */
const WEB_TOOLS = new Set([
    "WebSearch",
    "WebFetch",
    "web_search",
    "web_fetch",
    "claude_web_search",
    "codex_web_search",
    "gemini_web_search",
    "grok_web_search",
    "bedrock_web_search",
]);
/**
 * The web tools the agent called, from the stored tool_call blocks. Happy's own tools keep their name; the native
 * Claude Code harness stores its built-ins as `other` with the tool in the arguments' title.
 */
function webCalls(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) webCalls(item, out);
    } else if (value && typeof value === "object") {
        const block = value as { type?: unknown; name?: unknown; arguments?: unknown };
        if (block.type === "tool_call") {
            let title: unknown;
            try {
                title = (JSON.parse(String(block.arguments ?? "{}")) as { title?: unknown }).title;
            } catch {
                title = undefined;
            }
            for (const name of [block.name, title])
                if (typeof name === "string" && WEB_TOOLS.has(name)) out.push(name);
        }
        for (const child of Object.values(value)) webCalls(child, out);
    }
    return out;
}
/** The answer: the Node.js release schedule lives in the nodejs/release repository or on nodejs.org. */
const ANSWER_URL = /https:\/\/(?:github\.com\/nodejs\/release|nodejs\.org)[^\s"\\)]*/;

// Run from inside a Claude Code session, the child Claude would otherwise join that session's host.
for (const name of Object.keys(process.env)) {
    if (/^CLAUDE_(CODE_|AGENT_SDK_|PID$)/.test(name)) delete process.env[name];
}

describe.skipIf(!SPEC)("Orkest project session on Happy searches the web (GHO-205.1.2)", () => {
    it("a native Claude Code turn uses a web tool and answers with a URL", async () => {
        const spec = JSON.parse(await readFile(SPEC!, "utf8")) as RealSpec;
        const checks: { name: string; ok: boolean; detail?: string }[] = [];
        const check = (name: string, ok: boolean, detail?: unknown) => {
            checks.push({
                name,
                ok,
                ...(ok ? {} : { detail: String(detail ?? "").slice(0, 400) }),
            });
            return ok;
        };
        const answered: string[] = [];
        let reply = "";
        const happyHome = await mkdtemp(join(tmpdir(), "happy-web-live-"));
        let runtime: HappyAgentRuntime | undefined;
        let tick: ReturnType<typeof setInterval> | undefined;
        try {
            const environment = {
                ...process.env,
                ORKEST_AGENCY_URL: spec.fatherUrl,
                ORKEST_AGENCY_TOKEN_FILE: spec.agencyTokenFile,
                ORKEST_WORKER_TOKEN_FILE: spec.workerTokenFile,
                ORKEST_WORKER_ID: spec.workerId,
                ORKEST_SESSION_URL: spec.sessionUrl,
            };
            const configPath = (await ConfigModule.load(happyHome, { environment })).configuration
                .paths.globalConfigPath;
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                [
                    "[features]",
                    "attended_only = true",
                    "[settings]",
                    "happy_integration = false",
                    "inference_max_retries = 0",
                    // As the deployed tenant workers (orkest-happy-start.ps1): the machine's own sign-in, referenced.
                    "[defaults]",
                    'provider = "claude"',
                    'model = "claude-code/sonnet"',
                    'permission_mode = "read_only"',
                    "[providers.claude]",
                    'type = "claude"',
                    "enabled = true",
                    `config_dir = ${JSON.stringify(join(homedir(), ".claude").split("\\").join("/"))}`,
                    "[harnesses.happy]",
                    "enabled = false",
                    "[harnesses.claude_code]",
                    'providers = ["claude"]',
                    "",
                ].join("\n"),
            );
            runtime = await startHappyAgentRuntime({ happyHome, environment });
            const rt = runtime;
            const ctx = withAgentDatabase(rt.ctx, rt.database);
            const agentId = derivedId("a", spec.run.runId);

            await expect
                .poll(
                    async () =>
                        (await rt.modules.tasks.get(ctx, derivedId("t", spec.run.runId)))?.path ??
                        "",
                    { timeout: 90_000, interval: 500 },
                )
                .not.toBe("");
            check("the worker opens the happy project session", true);

            // A person would allow a web search once; the driver answers every approval the same way.
            tick = setInterval(async () => {
                const pending = await rt.modules.userInput
                    .list(ctx, agentId, { status: "pending" })
                    .catch(() => []);
                for (const question of pending) {
                    if (answered.includes(question.id)) continue;
                    answered.push(question.id);
                    await rt.modules.userInput
                        .answer(ctx, agentId, {
                            requestId: question.id,
                            answers: { approval: "Allow once" },
                        })
                        .catch(() => undefined);
                }
            }, 500);

            await rt.system.send(
                ctx,
                agentId,
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: [
                                `SYN ${spec.tag}. Search the web: where does the Node.js project publish its release`,
                                "schedule (which versions are LTS and when each reaches end of life)?",
                                "Use your web search tool, not memory, then reply with the page's full URL and one sentence.",
                            ].join("\n"),
                        },
                    ],
                },
                {
                    id: derivedId("a", `${spec.run.runId}:m1`),
                    provider: MODE.providerId,
                    model: MODE.modelId,
                    effort: MODE.effort,
                    serviceTier: null,
                    permissionMode: MODE.permissionMode,
                    metadata: { ...USER_MESSAGE_ORIGIN_METADATA, mode: MODE },
                },
            );
            const stateText = async () =>
                JSON.stringify(await rt.storage.persistence(agentId).load(ctx));
            try {
                await expect
                    .poll(stateText, { timeout: 300_000, interval: 2_000 })
                    .toMatch(new RegExp(`${ANSWER_URL.source}|"type":"error"|"error":\\{`));
            } catch {
                // The checks below say what is missing.
            }
            const state = await stateText();
            reply = state.slice(-2500);
            const near = (word: string) => {
                const at = state.indexOf(word);
                return at < 0
                    ? `no ${word} in the state`
                    : state.slice(Math.max(0, at - 200), at + 100);
            };
            check(
                "the agent ran a web tool (WebSearch, WebFetch or the provider's web search)",
                webCalls(JSON.parse(state)).length > 0,
                near("WebSearch"),
            );
            check(
                "the reply carries the release schedule's URL",
                ANSWER_URL.test(state),
                state.slice(-400),
            );
            check(
                "the turn ran on the native Claude Code harness",
                /claude-code\//.test(state),
                state.slice(0, 200),
            );
        } catch (error) {
            check(
                "the web-search driver ran to the end",
                false,
                error instanceof Error ? error.message : error,
            );
        } finally {
            if (tick) clearInterval(tick);
            await writeFile(
                spec.resultFile,
                JSON.stringify({ checks, approvalsAnswered: answered.length, reply }, null, 2),
            );
            if (runtime) {
                await runtime.modules.orkest.close();
                await runtime.close();
            }
            await rm(happyHome, {
                recursive: true,
                force: true,
                maxRetries: 3,
            }).catch(() => undefined);
        }
        expect(checks.filter((c) => !c.ok)).toEqual([]);
    }, 480_000);
});
