import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { derivedId } from "../../sources/orkest/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider, type ScriptedSession } from "../support/ScriptedProvider.js";
import { textTurn, toolCallTurn } from "../support/fixtures.js";

// GHO-204.4.1 — the live driver of the chat-by-project proof on lab1. Ghost's scripts/orkest-chat-by-project/live.mjs
// registers a HappyAttended worker for afk-probe, starts one `happy` project session as a person on a project whose
// repository has a local path on this host, checks that the owner feed carries that path (`scope.repoPath`) and writes
// a spec file; this file runs the real Happy runtime (the Orkest module as built) with a scripted agent against the
// live Father and writes what it saw to the spec's result file and to stdout (PASS / FAIL lines). No model runs.
// Skipped unless ORKEST_LIVE_SPEC names the spec.
//   npx vitest run --config vitest.live.config.ts tests/orkest/chatByProject.live.test.ts

interface LiveSpec {
    readonly fatherUrl: string;
    readonly sessionUrl: string;
    readonly agencyTokenFile: string;
    readonly workerTokenFile: string;
    readonly workerId: string;
    readonly tag: string;
    readonly run: { readonly runId: string; readonly projectId: string };
    /** The repository path the owner feed named for the project (`scope.repoPath`). */
    readonly repoPath: string;
    /** A file that exists in that repository, relative to its root, and a line it contains. */
    readonly readFile: string;
    readonly readMarker: string;
    /** A doc of that repository (docs/...) and a line it contains, for the read through the Orkest tools. */
    readonly docFile: string;
    readonly docMarker: string;
    readonly resultFile: string;
}

const SPEC = process.env.ORKEST_LIVE_SPEC;
const REFUSAL = /This is the project's repository/;

/** A path as a comparable string: forward slashes, no trailing slash, folded on Windows. */
const same = (a: string, b: string) => {
    const norm = (p: string) => {
        const text = p.trim().replaceAll("\\", "/").replace(/\/+$/, "");
        return process.platform === "win32" ? text.toLowerCase() : text;
    };
    return norm(a) === norm(b);
};

describe.skipIf(!SPEC)("Orkest chat by project on Happy, live (GHO-204.4.1)", () => {
    it("opens at the project's repository, reads a file there and is refused every write", async () => {
        const spec = JSON.parse(await readFile(SPEC!, "utf8")) as LiveSpec;
        const checks: { name: string; ok: boolean; detail?: string }[] = [];
        const check = (name: string, ok: boolean, detail?: unknown) => {
            const detailText = String(detail ?? "")
                .replace(/\s+/g, " ")
                .slice(0, 240);
            checks.push({ name, ok, ...(ok ? {} : { detail: detailText }) });
            console.log(ok ? `PASS ${name}` : `FAIL: ${name} ${detailText}`.trimEnd());
            return ok;
        };
        const home = await mkdtemp(join(tmpdir(), "happy-cbp-live-"));
        let runtime: HappyAgentRuntime | undefined;
        try {
            const environment = {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                ORKEST_AGENCY_URL: spec.fatherUrl,
                ORKEST_AGENCY_TOKEN_FILE: spec.agencyTokenFile,
                ORKEST_WORKER_TOKEN_FILE: spec.workerTokenFile,
                ORKEST_WORKER_ID: spec.workerId,
                ORKEST_SESSION_URL: spec.sessionUrl,
            };
            vi.stubEnv("HOME", home);
            const happyHome = join(home, ".happy");
            const configPath = (await ConfigModule.load(happyHome, { environment })).configuration
                .paths.globalConfigPath;
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, "[features]\nattended_only = true\n");

            const inRepo = (name: string) => join(spec.repoPath, ...name.split("/"));
            const exists = (path: string) =>
                stat(path).then(
                    () => true,
                    () => false,
                );
            const readmeBefore = await readFile(inRepo(spec.readFile), "utf8");
            const entriesBefore = new Set(await readdir(spec.repoPath));
            const probes = {
                patchAdd: inRepo("chat-by-project-probe-patch.txt"),
                shellEcho: inRepo("chat-by-project-probe-shell.txt"),
            };
            for (const probe of Object.values(probes)) await rm(probe, { force: true });

            // One message, five tool calls with the Claude-vendor tools (Read, Edit, Write and the shell, named PowerShell on Windows), which read a file
            // without the Windows sandbox: two reads, an edit and a write of files in the repository, a shell redirect.
            const call = (id: string, name: string, args: unknown) =>
                toolCallTurn(id, name, JSON.stringify(args));
            const script = [
                call("c1", "Read", { file_path: spec.readFile }),
                call("c2", "Read", { file_path: spec.docFile }),
                call("c3", "Edit", {
                    file_path: spec.readFile,
                    old_string: spec.readMarker,
                    new_string: `${spec.readMarker} SYN ${spec.tag} wrote here`,
                }),
                call("c4", "Write", {
                    file_path: "chat-by-project-probe-patch.txt",
                    content: `SYN ${spec.tag}\n`,
                }),
                call("c5", process.platform === "win32" ? "PowerShell" : "Bash", {
                    command: `echo SYN ${spec.tag} > chat-by-project-probe-shell.txt`,
                }),
                textTurn("Read it; the repository is read-only for me."),
            ];
            const provider = new ScriptedProvider(script);
            const providers = new AgentProviders();
            // The tool set follows the provider's vendor: "claude" gives Read, Edit, Write and Bash.
            providers.add("codex", provider, "claude");
            runtime = await startHappyAgentRuntime({
                happyHome,
                environment,
                inference: {
                    providers,
                    models: [
                        {
                            id: "codex-cli/gpt-6.1-sol",
                            providerId: "codex",
                            name: "Scripted",
                            defaultEffort: "medium",
                            effortLevels: ["medium"],
                        },
                    ],
                },
            });
            const rt = runtime;
            const ctx = withAgentDatabase(rt.ctx, rt.database);

            await expect
                .poll(
                    async () =>
                        (await rt.modules.tasks.get(ctx, derivedId("t", spec.run.runId)))?.path ??
                        "",
                    { timeout: 60_000, interval: 500 },
                )
                .not.toBe("");
            const config = await rt.system.config(ctx, derivedId("a", spec.run.runId));
            const cwd = config?.environment?.workingDirectory ?? "";
            check(
                "(a) the agent task's working directory is the project's repository",
                same(cwd, spec.repoPath),
                `cwd ${cwd} repoPath ${spec.repoPath}`,
            );
            check(
                "(a) the task carries the Orkest project id",
                config?.metadata?.["orkestProjectId"] === spec.run.projectId,
                config?.metadata?.["orkestProjectId"],
            );

            await rt.system.send(
                ctx,
                derivedId("a", spec.run.runId),
                {
                    role: "user",
                    content: [{ type: "text", text: `SYN ${spec.tag}: look around.` }],
                },
                {
                    id: derivedId("a", `${spec.run.runId}:m1`),
                    metadata: USER_MESSAGE_ORIGIN_METADATA,
                },
            );
            const sessionFor = (): ScriptedSession | undefined =>
                provider.sessions.find((s) =>
                    String(s.options.instructions ?? "").includes(spec.run.projectId),
                );
            const seen = () =>
                JSON.stringify(sessionFor()?.requests.map((r) => r.context.messages) ?? []);
            /** What each tool call answered, by call id, from the last request the model was shown. */
            const results = (): Record<string, string> => {
                const last = sessionFor()?.requests.at(-1)?.context.messages ?? [];
                const out: Record<string, string> = {};
                for (const message of last as unknown as {
                    role: string;
                    callId?: string;
                    content?: { text?: string }[];
                }[]) {
                    if (message.role === "tool" && message.callId !== undefined)
                        out[message.callId] = (message.content ?? [])
                            .map((part) => part.text ?? "")
                            .join(" ");
                }
                return out;
            };
            let finished = true;
            try {
                // The last scripted turn is a text answer, so the model has been shown all five tool results.
                await expect
                    .poll(() => provider.sessions.flatMap((s) => s.requests).length, {
                        timeout: 90_000,
                        interval: 500,
                    })
                    .toBeGreaterThanOrEqual(6);
            } catch {
                finished = false;
            }
            const text = seen();
            const answer = results();
            check("the scripted agent ran all five tool calls", finished, text.slice(-300));
            const instructions = String(sessionFor()?.options.instructions ?? "");
            check(
                "the preamble tells the agent it starts in the repository",
                instructions.includes("You start in the project's repository at "),
                instructions.slice(0, 200),
            );

            // (b) The agent reads files in its working directory with its own Read tool (no shell, no sandbox): one
            // by absolute path, one by a path relative to the working directory, which resolves in the repository.
            check(
                `(b) the agent reads ${spec.readFile} in the repository with its Read tool and gets its content`,
                (answer["c1"] ?? "").includes(spec.readMarker),
                answer["c1"],
            );
            check(
                `(b) the agent reads ${spec.docFile} by a relative path (its working directory) and gets its content`,
                (answer["c2"] ?? "").includes(spec.docMarker),
                answer["c2"],
            );

            // (c) Every write is refused by the repository guard, and nothing on disk changes.
            const byGuard = (id: string) => REFUSAL.test(answer[id] ?? "");
            check(
                "(c) the Edit of a file under the repository is refused by the guard",
                byGuard("c3"),
                answer["c3"],
            );
            check(
                "(c) the Write of a file under the repository is refused by the guard",
                byGuard("c4"),
                answer["c4"],
            );
            check(
                "(c) the shell redirect under the repository is refused by the guard",
                byGuard("c5"),
                answer["c5"],
            );
            check(
                "(c) the file on disk is unchanged",
                (await readFile(inRepo(spec.readFile), "utf8")) === readmeBefore,
            );
            check(
                "(c) the Write created no file",
                !(await exists(probes.patchAdd)),
                probes.patchAdd,
            );
            check(
                "(c) the shell redirect created no file",
                !(await exists(probes.shellEcho)),
                probes.shellEcho,
            );
            for (const probe of Object.values(probes)) await rm(probe, { force: true });
            // Not a check: what the runtime itself left in the repository (the Windows sandbox's empty placeholders
            // for protected names such as AGENTS.md), as opposed to anything the agent wrote.
            const left = (await readdir(spec.repoPath)).filter((name) => !entriesBefore.has(name));
            console.log(
                `INFO the runtime left ${left.length} new entries in the repository: ${left.join(", ") || "none"}`,
            );
        } catch (error) {
            check(
                "the live driver ran to the end",
                false,
                error instanceof Error ? error.message : error,
            );
        } finally {
            await writeFile(spec.resultFile, JSON.stringify({ checks }, null, 2));
            if (runtime) {
                await runtime.modules.orkest.close();
                await runtime.close();
            }
            await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
        }
        expect(checks.filter((c) => !c.ok)).toEqual([]);
    }, 400_000);
});
