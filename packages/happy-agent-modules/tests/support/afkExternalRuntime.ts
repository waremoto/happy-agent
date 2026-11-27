import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import type { SessionStream } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../../sources/config/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { toolCallTurn } from "../support/fixtures.js";
import { ScriptedProvider, type ScriptedTurn } from "../support/ScriptedProvider.js";

const MODEL_ID = "anthropic/afk-external-scripted";

export interface AfkExternalRuntimeOptions {
    url: string;
    token: string;
    tenantId: string;
    projectMapPath: string;
    workerId: string;
    timeoutMs: number;
    providerStrategy: "write-file" | "hang";
    /** Caller-owned home permits restart tests against the same persisted task/history. */
    home?: string;
}

export interface AfkExternalRuntime {
    close(): Promise<void>;
    observations: {
        readonly modelSendCount: number;
        readonly abortObserved: boolean;
        readonly status: { state: string; runs: number; lastError: string | null };
    };
}

/** Test-only live-Father seam: real Happy runtime/module/client, scripted model, isolated home. */
export async function startAfkExternalRuntime(
    options: AfkExternalRuntimeOptions,
): Promise<AfkExternalRuntime> {
    const parsedUrl = new URL(options.url);
    if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(parsedUrl.hostname)) {
        throw new Error("The external AFK runtime test helper only accepts loopback URLs.");
    }
    const home = options.home ?? (await mkdtemp(join(tmpdir(), "happy-afk-external-")));
    await mkdir(home, { recursive: true });
    const tokenFile = join(home, "worker.token");
    await writeFile(tokenFile, `${options.token}\n`);
    const environment = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORKEST_AFK_URL: options.url,
        ORKEST_AFK_WORKER_TOKEN_FILE: tokenFile,
        ORKEST_AFK_WORKER_ID: options.workerId,
        ORKEST_AFK_TENANT: options.tenantId,
        ORKEST_AFK_PROJECTS_FILE: options.projectMapPath,
        ORKEST_AFK_MODEL: `scripted:${MODEL_ID}`,
    };
    const globalConfig = (await ConfigModule.load(join(home, ".happy"), { environment }))
        .configuration.paths.globalConfigPath;
    await mkdir(dirname(globalConfig), { recursive: true });
    await writeFile(globalConfig, "[features]\nattended_only = true\n");

    let abortObserved = false;
    const runtimePromise: { current?: HappyAgentRuntime } = {};
    const waitForTaskPath = async (): Promise<string> => {
        for (let i = 0; i < 300; i += 1) {
            const runtime = runtimePromise.current;
            if (runtime !== undefined) {
                const tasks = await runtime.modules.tasks.list(
                    withAgentDatabase(runtime.ctx, runtime.database),
                );
                const task = tasks.find(
                    (item) => item.id.startsWith("kt") || item.folderName.startsWith("orkest_afk_"),
                );
                if (task !== undefined) {
                    const config = await runtime.system.config(
                        withAgentDatabase(runtime.ctx, runtime.database),
                        task.agentId,
                    );
                    const directory = config?.environment?.workingDirectory;
                    if (typeof directory === "string")
                        return join(directory, "output", "afk-timeout-proof.txt");
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Timed out waiting for the AFK project task.");
    };
    const hang: ScriptedTurn = (ctx: Context): SessionStream =>
        (async function* () {
            await new Promise<void>((resolve) => {
                if (ctx.lifetime?.aborted) {
                    abortObserved = true;
                    resolve();
                    return;
                }
                ctx.lifetime?.addEventListener(
                    "abort",
                    () => {
                        abortObserved = true;
                        resolve();
                    },
                    { once: true },
                );
            });
        })();
    const script: ScriptedTurn[] =
        options.providerStrategy === "hang"
            ? [hang]
            : [
                  () =>
                      (async function* () {
                          const path = await waitForTaskPath();
                          yield* toolCallTurn(
                              "afk-external-write",
                              "Write",
                              JSON.stringify({ file_path: path, content: "bounded proof" }),
                          );
                      })(),
                  hang,
              ];
    const provider = new ScriptedProvider(script);
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
    const runtime = await startHappyAgentRuntime({
        happyHome: join(home, ".happy"),
        environment,
        inference: {
            providers,
            models: [
                {
                    id: MODEL_ID,
                    providerId: "scripted",
                    name: "Scripted",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
    });
    runtimePromise.current = runtime;
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await runtime.modules.orkestAfk.close();
        await runtime.close();
    };
    const timer = setTimeout(
        () => {
            void close();
        },
        Math.max(1, options.timeoutMs),
    );
    timer.unref?.();
    return {
        close: async () => {
            clearTimeout(timer);
            await close();
        },
        get observations() {
            return {
                modelSendCount: provider.sessions.reduce(
                    (total, session) => total + session.requests.length,
                    0,
                ),
                abortObserved,
                status: runtime.modules.orkestAfk.status,
            };
        },
    };
}
