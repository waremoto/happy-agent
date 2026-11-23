import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
    ScriptedProvider,
    type ScriptedSession,
    type ScriptedTurn,
} from "../support/ScriptedProvider.js";
import { textTurn, toolCallTurn } from "../support/fixtures.js";

// GHO-196.4.2 — the live driver of the Happy project session proof on lab1. Ghost's
// scripts/orkest-project-session-happy-live.mjs registers a HappyAttended worker for afk-probe, starts two `happy`
// project sessions as a person and writes a spec file; this file runs the real Happy runtime (the adapter as built)
// with a scripted agent against the live Father and dashboard, and writes what it saw to the spec's result file.
// No model runs and no real sign-in is used. Skipped unless ORKEST_LIVE_SPEC names the spec.
//   npx vitest run --config vitest.live.config.ts tests/orkest/projectSession.live.test.ts

interface LiveSpec {
    readonly fatherUrl: string;
    readonly sessionUrl: string;
    readonly agencyTokenFile: string;
    readonly workerTokenFile: string;
    readonly workerId: string;
    readonly doc: string;
    readonly tag: string;
    readonly docsRun: { readonly runId: string; readonly projectId: string };
    readonly emptyRun: { readonly runId: string; readonly projectId: string };
    readonly resultFile: string;
}

const SPEC = process.env.ORKEST_LIVE_SPEC;
const STALE_BASE = "f".repeat(40);

describe.skipIf(!SPEC)("Orkest project session on Happy, live (GHO-196.4.2)", () => {
    it("opens both sessions, reads, proposes through a stale base, refuses a huge doc and works with no docs", async () => {
        const spec = JSON.parse(await readFile(SPEC!, "utf8")) as LiveSpec;
        const checks: { name: string; ok: boolean; detail?: string }[] = [];
        const check = (name: string, ok: boolean, detail?: unknown) => {
            checks.push({
                name,
                ok,
                ...(ok ? {} : { detail: String(detail ?? "").slice(0, 240) }),
            });
            return ok;
        };
        const home = await mkdtemp(join(tmpdir(), "happy-ps-live-"));
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

            const taskPath: Record<string, string> = {};
            const copyOf = () =>
                join(taskPath.docs!, "doc", ...spec.doc.slice("docs/".length).split("/"));
            const basesOf = () => join(taskPath.docs!, "doc", ".orkest-bases.json");
            const line = `- SYN ${spec.tag}: proposed by a Happy project session (GHO-196 live proof, scripted agent).\n`;
            const tool = (
                callId: string,
                name: string,
                args: unknown,
                before?: () => Promise<void>,
            ): ScriptedTurn =>
                before === undefined
                    ? toolCallTurn(callId, name, JSON.stringify(args))
                    : () =>
                          (async function* () {
                              await before();
                              yield* toolCallTurn(callId, name, JSON.stringify(args));
                          })();
            const script: ScriptedTurn[] = [
                // The docs session, first message: read, edit, propose on a stale base, re-apply, propose.
                tool("l1", "list_docs", {}),
                tool("r1", "read_doc", { path: spec.doc }),
                tool(
                    "p1",
                    "propose_document",
                    { path: spec.doc, why: `${spec.tag}: add a SYN line` },
                    async () => {
                        await writeFile(
                            copyOf(),
                            `${(await readFile(copyOf(), "utf8")).replace(/\n*$/, "\n")}${line}`,
                        );
                        // As if a person had moved the doc since the copy was made: the seam answers stale_base.
                        const bases = JSON.parse(await readFile(basesOf(), "utf8")) as Record<
                            string,
                            string | null
                        >;
                        await writeFile(
                            basesOf(),
                            JSON.stringify({ ...bases, [spec.doc]: STALE_BASE }),
                        );
                    },
                ),
                tool(
                    "p2",
                    "propose_document",
                    { path: spec.doc, why: `${spec.tag}: add a SYN line again` },
                    async () => {
                        await writeFile(
                            copyOf(),
                            `${(await readFile(copyOf(), "utf8")).replace(/\n*$/, "\n")}${line}`,
                        );
                    },
                ),
                textTurn("Proposed; it waits for you on the Board."),
                // Second message: a document over the seam's limit.
                tool(
                    "p3",
                    "propose_document",
                    { path: spec.doc, why: `${spec.tag}: too large` },
                    async () => {
                        await writeFile(copyOf(), `# SYN\n\n${"x".repeat(60_001)}\n`);
                    },
                ),
                textTurn("Too large."),
                // The no-docs session.
                tool("l2", "list_docs", {}),
                textTurn("This project has no docs yet."),
            ];
            const provider = new ScriptedProvider(script);
            const providers = new AgentProviders();
            providers.add("codex", provider, "codex");
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

            const opened = async (runId: string) => {
                await expect
                    .poll(
                        async () =>
                            (await rt.modules.tasks.get(ctx, derivedId("t", runId)))?.path ?? "",
                        {
                            timeout: 60_000,
                            interval: 500,
                        },
                    )
                    .not.toBe("");
                return (await rt.modules.tasks.get(ctx, derivedId("t", runId)))!.path;
            };
            taskPath.docs = await opened(spec.docsRun.runId);
            taskPath.empty = await opened(spec.emptyRun.runId);
            check("the worker opens both happy project sessions as tasks", true);
            await expect
                .poll(async () => readFile(copyOf(), "utf8").catch(() => ""), { timeout: 30_000 })
                .not.toBe("");
            const firstCopy = await readFile(copyOf(), "utf8");
            const firstBase = (
                JSON.parse(await readFile(basesOf(), "utf8")) as Record<string, string>
            )[spec.doc];
            check(
                `the focus doc's working copy is written from read_doc (${spec.doc})`,
                firstCopy.startsWith("#") && /^[0-9a-f]{40}$/.test(firstBase ?? ""),
                firstBase,
            );

            const say = async (runId: string, text: string, id: string) =>
                rt.system.send(
                    ctx,
                    derivedId("a", runId),
                    { role: "user", content: [{ type: "text", text }] },
                    {
                        id: derivedId("a", `${runId}:${id}`),
                        metadata: USER_MESSAGE_ORIGIN_METADATA,
                    },
                );
            const sessionFor = (projectId: string) =>
                provider.sessions.find((s) =>
                    String(s.options.instructions ?? "").includes(projectId),
                );
            const seen = (s: ScriptedSession | undefined) =>
                JSON.stringify(s?.requests.map((r) => r.context.messages) ?? []);
            const settled = async (projectId: string, pattern: RegExp) => {
                try {
                    await expect
                        .poll(() => seen(sessionFor(projectId)), { timeout: 60_000, interval: 500 })
                        .toMatch(pattern);
                    return true;
                } catch {
                    return false;
                }
            };

            await say(spec.docsRun.runId, `SYN ${spec.tag}: add a line to the roadmap.`, "m1");
            const proposed = await settled(spec.docsRun.projectId, /Proposed \d+ changes? to/);
            const docs = sessionFor(spec.docsRun.projectId);
            const instructions = String(docs?.options.instructions ?? "");
            check(
                "the docs session's preamble names the project, its focus copy and propose_document",
                instructions.includes("Orkest project session") &&
                    instructions.includes(`doc/${spec.doc.slice(5)}`) &&
                    instructions.includes("propose_document"),
                instructions.slice(0, 200),
            );
            const text = seen(docs);
            check("list_docs through the tools API lists the doc", text.includes(spec.doc));
            check(
                "read_doc writes the working copy",
                text.includes(`Working copy written: doc/${spec.doc.slice(5)}`),
            );
            check(
                "a stale base refreshes the copy and asks to apply the change again",
                /moved since your working copy/.test(text),
                text.slice(-300),
            );
            check(
                "the re-applied change is proposed (it waits on the Board)",
                proposed,
                text.slice(-300),
            );
            const final = await readFile(copyOf(), "utf8");
            check(
                "the proposed copy carries the SYN line once on the current text",
                final.split(line).length === 2,
            );

            await say(spec.docsRun.runId, `SYN ${spec.tag}: try one that is too large.`, "m2");
            check(
                "a document over 60 000 characters is refused as too large",
                await settled(spec.docsRun.projectId, /over 60 000 characters/),
                seen(docs).slice(-300),
            );

            await say(spec.emptyRun.runId, `SYN ${spec.tag}: what is here?`, "m1");
            const emptyOk = await settled(spec.emptyRun.projectId, /no docs yet/);
            const empty = sessionFor(spec.emptyRun.projectId);
            check(
                "the no-docs session's preamble says the project has no docs yet",
                /no docs yet/.test(String(empty?.options.instructions ?? "")),
                String(empty?.options.instructions ?? "").slice(0, 200),
            );
            check(
                "list_docs in the no-docs project answers empty, not a refusal",
                emptyOk && /has no docs yet/.test(seen(empty)),
                seen(empty).slice(-300),
            );
            check(
                "the no-docs session has no working copy",
                !(await readFile(join(taskPath.empty!, "doc", "ROADMAP.md"), "utf8").then(
                    () => true,
                    () => false,
                )),
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
