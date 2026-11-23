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

// GHO-196.4.3 — a REAL model turn through the Happy project session on lab1. Ghost's
// scripts/orkest-project-session-happy-real.mjs registers a HappyAttended worker for afk-probe, starts one `happy`
// project session (harness claude) as a person and writes a spec file; this file runs the real Happy runtime with the
// machine's own Claude Code sign-in (native harness, nothing copied), sends one person message, approves the agent's
// edits of its working copy, and waits for its own `propose_document` call to answer "Proposed". Skipped unless
// ORKEST_REAL_SPEC names the spec.
//   npx vitest run --config vitest.live.config.ts tests/orkest/projectSessionReal.live.test.ts

interface RealSpec {
    readonly fatherUrl: string;
    readonly sessionUrl: string;
    readonly agencyTokenFile: string;
    readonly workerTokenFile: string;
    readonly workerId: string;
    readonly doc: string;
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
    permissionMode: "workspace_write",
} as const;

// Run from inside a Claude Code session, the child Claude would otherwise join that session's host.
for (const name of Object.keys(process.env)) {
    if (/^CLAUDE_(CODE_|AGENT_SDK_|PID$)/.test(name)) delete process.env[name];
}

describe.skipIf(!SPEC)("Orkest project session on Happy, real model turn (GHO-196.4.3)", () => {
    it("a native Claude Code turn edits its working copy and proposes it", async () => {
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
        const happyHome = await mkdtemp(join(tmpdir(), "happy-ps-real-"));
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
            const taskPath = (await rt.modules.tasks.get(ctx, derivedId("t", spec.run.runId)))!
                .path;
            const copy = join(taskPath, "doc", ...spec.doc.slice("docs/".length).split("/"));
            await expect
                .poll(async () => readFile(copy, "utf8").catch(() => ""), {
                    timeout: 30_000,
                })
                .not.toBe("");
            const before = await readFile(copy, "utf8");
            check("the worker opens the happy project session with its working copy", true);

            // The person approves the agent's edits of its own working copy, once each.
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

            const line = `- SYN ${spec.tag}: proposed by a real Happy project session turn (GHO-196.4.3).`;
            await rt.system.send(
                ctx,
                agentId,
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: [
                                `SYN ${spec.tag}. Append exactly this line at the end of your working copy of ${spec.doc}`,
                                `(the file doc/${spec.doc.slice(5)} in your folder), changing nothing else:`,
                                "",
                                line,
                                "",
                                `Then call propose_document with path "${spec.doc}" and why "${spec.tag}: add a SYN line".`,
                                "Reply with the tool's answer in one sentence.",
                            ].join("\n"),
                        },
                    ],
                },
                // As the composer sends it (ApiModule): the mode the session opened with.
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
            let proposed = false;
            try {
                await expect
                    .poll(stateText, { timeout: 300_000, interval: 2_000 })
                    .toMatch(
                        /Proposed \d+ changes? to|already proposed|held for|unchanged|"type":"error"|"error":\{/,
                    );
                proposed = /Proposed \d+ changes? to/.test(await stateText());
            } catch {
                proposed = false;
            }
            const state = await stateText();
            reply = state.slice(-2500);
            const after = await readFile(copy, "utf8");
            check(
                "the agent edited its working copy (the SYN line is in it)",
                after.includes(line) && after !== before,
                after.slice(-300),
            );
            check(
                "the agent's own propose_document call answered Proposed",
                proposed,
                state.slice(-400),
            );
            check(
                "the turn ran on the native Claude Code harness",
                /claude-code\//.test(state),
                state.slice(0, 200),
            );
        } catch (error) {
            check(
                "the real driver ran to the end",
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
