import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { withAgentDatabase } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { derivedId } from "../../sources/orkest/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";

// GHO-207.2 — harness parity at the project path, with REAL model turns on lab1. Ghost's
// scripts/orkest-chat-harness/parity.mjs registers a HappyAttended worker for afk-probe, starts `happy` project sessions
// (harness claude or codex) on synthetic projects whose repositories are local folders, and writes a spec; this file
// runs the real Happy runtime with the machine's own Claude Code and Codex sign-ins (referenced, never copied) and
// reports what each session did. Cases:
//   parity        — the session's cwd is the repository, it knows the marker that only its CLAUDE.md or AGENTS.md
//                   holds (no tools allowed), and it lists the repository's `ork` skill;
//   missing       — Father names a repository that is not on this host: the first reply says so;
//   harness-mode  — the repository's committed harness mode is on: an in-path write and a local commit need no card,
//                   and `git push` still reaches the person (who refuses it here);
//   gate          — an `orkest.py gate run` started in one turn outlives it, and the next turn reads its verdict.
// Skipped unless ORKEST_PARITY_SPEC names the spec.
//   npx vitest run --config vitest.live.config.ts tests/orkest/harnessParity.live.test.ts

type Case = "parity" | "missing" | "harness-mode" | "gate";
interface SessionSpec {
    readonly case: Case;
    readonly runId: string;
    /** The repository the session should open in (parity, harness-mode, gate) or the missing path (missing). */
    readonly repoPath: string;
    readonly marker?: string;
}
interface ParitySpec {
    readonly fatherUrl: string;
    readonly sessionUrl: string;
    readonly agencyTokenFile: string;
    readonly workerTokenFile: string;
    readonly workerId: string;
    readonly tag: string;
    readonly harness: "claude" | "codex";
    readonly sessions: readonly SessionSpec[];
    readonly resultFile: string;
    readonly gateWaitMs?: number;
}

const SPEC = process.env.ORKEST_PARITY_SPEC;
const MODELS = { claude: "claude-code/sonnet", codex: "codex-cli/gpt-6.1-sol" } as const;

// Run from inside a Claude Code session, the child Claude would otherwise join that session's host.
for (const name of Object.keys(process.env)) {
    if (/^CLAUDE_(CODE_|AGENT_SDK_|PID$)/.test(name)) delete process.env[name];
}

const home = homedir().split("\\").join("/");
const slash = (p: string) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();

/** Every string in a JSON value, depth first. */
function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) strings(v, out);
    else if (value !== null && typeof value === "object")
        for (const v of Object.values(value)) strings(v, out);
    return out;
}

describe.skipIf(!SPEC)("Orkest harness parity at the project path, real model turns (GHO-207.2)", () => {
    it("each session works in its repository as the native harness does", async () => {
        const spec = JSON.parse(await readFile(SPEC!, "utf8")) as ParitySpec;
        const checks: { name: string; ok: boolean; detail?: string }[] = [];
        const check = (name: string, ok: boolean, detail?: unknown) => {
            checks.push({
                name: `${spec.harness}: ${name}`,
                ok,
                ...(ok ? {} : { detail: String(detail ?? "").slice(0, 400) }),
            });
            return ok;
        };
        const cards: { case: Case; action: string; allowed: boolean }[] = [];
        const replies: Record<string, string> = {};
        const happyHome = await mkdtemp(join(tmpdir(), "happy-parity-"));
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
            // As the deployed tenant workers (orkest-happy-start.ps1): the machine's own sign-ins, referenced.
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
                    `config_dir = ${JSON.stringify(`${home}/.claude`)}`,
                    "[providers.codex]",
                    'type = "codex"',
                    "enabled = true",
                    `auth_file = ${JSON.stringify(`${home}/.codex/auth.json`)}`,
                    "[harnesses.happy]",
                    "enabled = false",
                    "[harnesses.claude_code]",
                    'providers = ["claude"]',
                    "[harnesses.codex_cli]",
                    'providers = ["codex"]',
                    "",
                ].join("\n"),
            );
            runtime = await startHappyAgentRuntime({ happyHome, environment });
            const rt = runtime;
            const ctx = withAgentDatabase(rt.ctx, rt.database);
            const caseOf = new Map(spec.sessions.map((s) => [derivedId("a", s.runId), s.case]));

            // The person's cards: a push is refused, anything else is allowed (and counted, so harness mode's
            // "no card" can be checked).
            const answered = new Set<string>();
            tick = setInterval(async () => {
                for (const [agentId, which] of caseOf) {
                    const pending = await rt.modules.userInput
                        .list(ctx, agentId, { status: "pending" })
                        .catch(() => []);
                    for (const question of pending) {
                        if (answered.has(question.id)) continue;
                        answered.add(question.id);
                        const text = JSON.stringify(question);
                        // Any git invocation that pushes, including `git -C <path> push` (GHO-207 QA: that form was
                        // answered "Allow once" and failed the harness-mode case).
                        const allowed = !/\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/i.test(text);
                        cards.push({ case: which, action: text.slice(0, 300), allowed });
                        await rt.modules.userInput
                            .answer(ctx, agentId, {
                                requestId: question.id,
                                answers: { approval: allowed ? "Allow once" : "Deny" },
                            })
                            .catch(() => undefined);
                    }
                }
            }, 400);

            const mode = {
                providerId: spec.harness,
                modelId: MODELS[spec.harness],
                effort: "medium",
                serviceTier: null,
                permissionMode: "workspace_write",
            } as const;
            const say = async (session: SessionSpec, text: string, n: number) =>
                await rt.system.send(
                    ctx,
                    derivedId("a", session.runId),
                    { role: "user", content: [{ type: "text", text }] },
                    {
                        id: derivedId("a", `${session.runId}:m${n}`),
                        provider: mode.providerId,
                        model: mode.modelId,
                        effort: mode.effort,
                        serviceTier: null,
                        permissionMode: mode.permissionMode,
                        metadata: { ...USER_MESSAGE_ORIGIN_METADATA, mode },
                    },
                );
            const textsOf = async (session: SessionSpec) =>
                strings(await rt.storage.persistence(derivedId("a", session.runId)).load(ctx));
            /** Wait for a string that matches, or an error, and return the last match. */
            const waitFor = async (session: SessionSpec, pattern: RegExp, timeout = 300_000) => {
                const until = Date.now() + timeout;
                while (Date.now() < until) {
                    const found = (await textsOf(session)).filter((s) => pattern.test(s) && !s.startsWith("SYN "));
                    if (found.length > 0) return found[found.length - 1]!;
                    await new Promise((r) => setTimeout(r, 2_000));
                }
                return undefined;
            };

            for (const session of spec.sessions) {
                await expect
                    .poll(
                        async () =>
                            (await rt.modules.tasks.get(ctx, derivedId("t", session.runId)))?.path ?? "",
                        { timeout: 120_000, interval: 500 },
                    )
                    .not.toBe("");
                const config = await rt.system.config(ctx, derivedId("a", session.runId));
                const cwd = String(config?.environment?.workingDirectory ?? "");
                const tag = `${spec.tag}-${session.case}`;
                if (session.case === "parity") {
                    check("the parity session opens in the repository", slash(cwd) === slash(session.repoPath), cwd);
                    await say(
                        session,
                        [
                            `SYN ${tag}. Answer from what you were given, WITHOUT using any tool, in ONE line that starts with PARITY and then a JSON object:`,
                            '{"cwd": your current working directory as an absolute path, "marker": the value after "SYN-MARKER:" in your project instructions (CLAUDE.md or AGENTS.md), "skills": the names of every skill available to you}',
                            "If you were not given one of them, use null.",
                        ].join("\n"),
                        1,
                    );
                    const line = await waitFor(session, /PARITY\s*\{/);
                    replies[session.case] = (line ?? "").slice(0, 1500);
                    let parsed: { cwd?: unknown; marker?: unknown; skills?: unknown } = {};
                    try {
                        parsed = JSON.parse(line!.slice(line!.indexOf("{"), line!.lastIndexOf("}") + 1));
                    } catch {
                        parsed = {};
                    }
                    check("the agent reports its cwd as the repository", typeof parsed.cwd === "string" && slash(parsed.cwd) === slash(session.repoPath), parsed.cwd ?? line);
                    check(
                        `the agent knows the instructions file's marker without a tool (${session.marker})`,
                        parsed.marker === session.marker,
                        parsed.marker ?? line,
                    );
                    const skills = Array.isArray(parsed.skills) ? parsed.skills.map((s) => String(s).toLowerCase()) : [];
                    check("the agent lists the repository's ork skill", skills.some((s) => s === "ork" || s.startsWith("ork@") || s.endsWith(":ork") || s === "/ork"), skills.join(","));
                    check("no tool card was raised for a no-tool answer", cards.filter((c) => c.case === "parity").length === 0, cards.filter((c) => c.case === "parity").map((c) => c.action).join(" | "));
                } else if (session.case === "missing") {
                    await say(session, `SYN ${tag}. Say hello in one short sentence.`, 1);
                    const reply = await waitFor(session, /not on this host/i, 240_000);
                    replies[session.case] = (reply ?? "").slice(0, 600);
                    check("the first reply tells the person the repository is not on this host", reply !== undefined && reply.includes(session.repoPath.split("\\").join("/").split("/").pop()!), reply);
                } else if (session.case === "harness-mode") {
                    check("the harness-mode session opens in the repository", slash(cwd) === slash(session.repoPath), cwd);
                    const file = `notes/${tag}.txt`;
                    await say(
                        session,
                        [
                            `SYN ${tag}. Do these three steps in this repository, each as its own separate tool call, and do not combine commands:`,
                            `1. Create the file ${file} containing exactly the line ${tag}.`,
                            `2. Run: git add ${file}`,
                            `3. Run: git commit -m "SYN ${tag}"`,
                            "Then, as a fourth and separate tool call, run: git push origin main",
                            "Finally reply with one line: HM-DONE and whether each step worked.",
                        ].join("\n"),
                        1,
                    );
                    const done = await waitFor(session, /HM-DONE/);
                    replies[session.case] = (done ?? "").slice(0, 800);
                    const written = await readFile(join(session.repoPath, file), "utf8").catch(() => "");
                    check("the agent wrote the file in the repository", written.includes(tag), written);
                    const log = (() => {
                        try {
                            return execFileSync("git", ["-C", session.repoPath, "log", "--format=%s", "-5"], { encoding: "utf8" });
                        } catch (error) {
                            return String(error);
                        }
                    })();
                    check("the agent made the local commit", log.includes(`SYN ${tag}`), log);
                    const mine = cards.filter((c) => c.case === "harness-mode");
                    check("no card asked for the in-path write, add or commit", mine.filter((c) => c.allowed).length === 0, mine.map((c) => c.action).join(" | "));
                    check("git push still reached the person's card (and was refused)", mine.some((c) => !c.allowed), mine.length);
                } else if (session.case === "gate") {
                    check("the gate session opens in the repository", slash(cwd) === slash(session.repoPath), cwd);
                    const name = `syn-${spec.harness}-gate`;
                    await say(
                        session,
                        [
                            `SYN ${tag}. Start a durable gate and do NOT wait for its verdict: run exactly`,
                            `py -3.12 bin/orkest.py --repo . gate run --name ${name} --no-queue --max-wait 5 -- py -3.12 scripts/slow_check.py`,
                            "It answers within seconds while the gate keeps running in the background. Then reply with one line: GATE-STARTED and the gate id it printed.",
                        ].join("\n"),
                        1,
                    );
                    const started = await waitFor(session, /GATE-STARTED/);
                    check("turn 1 started the gate and ended", started !== undefined, started);
                    await new Promise((r) => setTimeout(r, spec.gateWaitMs ?? 90_000));
                    await say(
                        session,
                        [
                            `SYN ${tag}. Read the verdict of the gate you started: run`,
                            `py -3.12 bin/orkest.py --repo . --max-s 120 gate wait ${name}`,
                            "and reply with one line: GATE-VERDICT, the verdict's outcome, and whether it was detached.",
                        ].join("\n"),
                        2,
                    );
                    const verdict = await waitFor(session, /GATE-VERDICT/);
                    replies[session.case] = `${started ?? ""} || ${verdict ?? ""}`.slice(0, 1200);
                    check("turn 2 read a passing verdict of the gate turn 1 started", verdict !== undefined && /pass/i.test(verdict), verdict);
                    const gateCards = cards.filter((c) => c.case === "gate");
                    check("under harness mode the gate ran and was read with no card", gateCards.length === 0, gateCards.map((c) => c.action).join(" | "));
                }
            }
        } catch (error) {
            check("the parity driver ran to the end", false, error instanceof Error ? error.message : error);
        } finally {
            if (tick) clearInterval(tick);
            await writeFile(spec.resultFile, JSON.stringify({ checks, cards, replies }, null, 2));
            if (runtime) {
                await runtime.modules.orkest.close();
                await runtime.close();
            }
            await rm(happyHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
        }
        await stat(spec.resultFile);
        expect(checks.filter((c) => !c.ok)).toEqual([]);
    }, 1_500_000);
});
