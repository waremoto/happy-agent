import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

// GHO-202 — the Orkest project session bake-off (stage 8), Happy half. Ghost's scripts/orkest-bakeoff/run.mjs drives
// it through files in `spec.dir`:
//   ready.json       written here once the runtime is up (pid, the Happy home)
//   run.json         written by the runner after it starts the session: { runId, projectId }
//   session.json     written here once the worker opened the session: { taskPath, copyDir }
//   cmd-<k>.json     written by the runner: { type: "send", text, timeoutMs } or { type: "end" }
//   res-<k>.json     written here: { sentAt, doneAt, reason, dump } — every record of the agent's store first seen
//                    after the send, stamped with the time (ms) it was first seen, plus the approvals answered.
// The runtime runs on this machine's own Claude Code sign-in (native harness, referenced, nothing copied), as the
// GHO-196.4.3 real driver does. The Happy home is persistent, so a second run after a kill resumes the same agent
// (the kill-and-reopen task). Skipped unless ORKEST_BAKEOFF_SPEC names the spec.
//   npx vitest run --config vitest.live.config.ts tests/orkest/projectSessionBakeoff.live.test.ts

interface BakeoffSpec {
    readonly fatherUrl: string;
    readonly sessionUrl: string;
    readonly agencyTokenFile: string;
    readonly workerTokenFile: string;
    readonly workerId: string;
    readonly happyHome: string;
    readonly dir: string;
    readonly doc: string;
    readonly idleMs?: number;
    /** The first command to read; a driver restarted after a kill continues where the killed one stopped. */
    readonly firstCmd?: number;
}

type Cmd =
    | { readonly type: "send"; readonly text: string; readonly timeoutMs?: number }
    | { readonly type: "end" };

const SPEC = process.env.ORKEST_BAKEOFF_SPEC;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function writeJson(path: string, value: unknown) {
    await writeFile(`${path}.tmp`, JSON.stringify(value));
    await rename(`${path}.tmp`, path);
}
async function waitFile<T>(path: string, timeoutMs: number): Promise<T | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (existsSync(path)) {
            try {
                return JSON.parse(await readFile(path, "utf8")) as T;
            } catch {
                // half-written: read again
            }
        }
        await sleep(250);
    }
    return null;
}

describe.skipIf(!SPEC)("Orkest project session bake-off on Happy (GHO-202)", () => {
    it("runs the runner's scripted turns and stamps every record", async () => {
        const spec = JSON.parse(await readFile(SPEC!, "utf8")) as BakeoffSpec;
        const idleMs = spec.idleMs ?? 20_000;
        let runtime: HappyAgentRuntime | undefined;
        let tick: ReturnType<typeof setInterval> | undefined;
        const answered: string[] = [];
        try {
            const environment = {
                ...process.env,
                ORKEST_AGENCY_URL: spec.fatherUrl,
                ORKEST_AGENCY_TOKEN_FILE: spec.agencyTokenFile,
                ORKEST_WORKER_TOKEN_FILE: spec.workerTokenFile,
                ORKEST_WORKER_ID: spec.workerId,
                ORKEST_SESSION_URL: spec.sessionUrl,
            };
            await mkdir(spec.happyHome, { recursive: true });
            const configPath = (await ConfigModule.load(spec.happyHome, { environment }))
                .configuration.paths.globalConfigPath;
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                [
                    "[features]",
                    "attended_only = true",
                    "[settings]",
                    "happy_integration = false",
                    "inference_max_retries = 0",
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
            const startedAt = Date.now();
            runtime = await startHappyAgentRuntime({ happyHome: spec.happyHome, environment });
            const rt = runtime;
            const ctx = withAgentDatabase(rt.ctx, rt.database);
            await writeJson(join(spec.dir, "ready.json"), {
                pid: process.pid,
                startMs: Date.now() - startedAt,
                at: Date.now(),
            });

            const run = await waitFile<{ runId: string; projectId: string }>(
                join(spec.dir, "run.json"),
                600_000,
            );
            expect(run, "the runner started a session").not.toBeNull();
            const agentId = derivedId("a", run!.runId);
            const taskId = derivedId("t", run!.runId);
            let taskPath = "";
            const claimUntil = Date.now() + 180_000;
            while (!taskPath && Date.now() < claimUntil) {
                taskPath = (await rt.modules.tasks.get(ctx, taskId))?.path ?? "";
                if (!taskPath) await sleep(250);
            }
            expect(taskPath, "the worker opened the session as a task").not.toBe("");
            await writeJson(join(spec.dir, "session.json"), {
                taskPath,
                copyDir: join(taskPath, "doc"),
                claimedAt: Date.now(),
            });

            // The person lets the agent edit its own working copy, once each (as the real driver does).
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
            }, 300);

            // Every record of the store, stamped with the time it was first seen.
            const stamps: number[] = [];
            const load = async () => {
                const records = await rt.storage.persistence(agentId).load(ctx).catch(() => []);
                const now = Date.now();
                while (stamps.length < records.length) stamps.push(now);
                return records;
            };
            await load();

            for (let k = spec.firstCmd ?? 1; ; k++) {
                const cmd = await waitFile<Cmd>(join(spec.dir, `cmd-${k}.json`), 3_600_000);
                if (!cmd || cmd.type === "end") break;
                const from = (await load()).length;
                const sentAt = Date.now();
                await rt.system.send(
                    ctx,
                    agentId,
                    { role: "user", content: [{ type: "text", text: cmd.text }] },
                    {
                        id: derivedId("a", `${run!.runId}:bakeoff:${k}:${sentAt}`),
                        provider: MODE.providerId,
                        model: MODE.modelId,
                        effort: MODE.effort,
                        serviceTier: null,
                        permissionMode: MODE.permissionMode,
                        metadata: { ...USER_MESSAGE_ORIGIN_METADATA, mode: MODE },
                    },
                );
                const until = sentAt + (cmd.timeoutMs ?? 600_000);
                let reason = "timeout";
                let lastCount = from;
                let lastChange = Date.now();
                while (Date.now() < until) {
                    const records = await load();
                    if (records.length !== lastCount) {
                        lastCount = records.length;
                        lastChange = Date.now();
                    }
                    const mine = records.slice(from);
                    const tail = mine[mine.length - 1];
                    const lastIsText =
                        tail?.type === "block" && tail.block.type === "text" && !!tail.block.text?.trim();
                    // A turn is over when its last record is the agent's text and nothing new came for idleMs.
                    if (lastIsText && Date.now() - lastChange > idleMs) {
                        reason = "idle";
                        break;
                    }
                    await sleep(500);
                }
                const records = await load();
                await writeJson(join(spec.dir, `res-${k}.json`), {
                    sentAt,
                    doneAt: Date.now(),
                    reason,
                    approvalsAnswered: answered.length,
                    dump: records.slice(from).map((rec, i) => ({ t: stamps[from + i], rec })),
                });
            }
        } finally {
            if (tick) clearInterval(tick);
            if (runtime) {
                await runtime.modules.orkest.close();
                await runtime.close();
            }
        }
    }, 7_200_000);
});
