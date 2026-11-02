import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { OrkestModule, derivedId } from "../../sources/orkest/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const TOKEN = "orkest-test-service-token-0123456789abcdef";
const RUN = "0195f3a0-0000-7000-8000-000000000001";
const INTENT = "0195f3a0-0000-7000-8000-0000000000aa";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60_000);

interface Call {
    method: string;
    path: string;
    body: unknown;
}

/**
 * Father's agency endpoints, in memory: one attended run waiting for its owner. It answers only the
 * right service token and records every call, so the test sees what the owner asked for.
 */
async function fakeAgency() {
    const calls: Call[] = [];
    const run = {
        runId: RUN,
        state: "admitted",
        harness: "codex",
        permissionMode: "read_only",
        title: "WAR-7: Tighten the login check",
        brief: "The login check accepts an expired session.",
        workLabel: "WAR-7",
        endRequestedAt: null as string | null,
        intentId: INTENT,
        ownerJobRef: null as string | null,
        fence: 0,
    };
    let intent: "pending" | "acknowledged" = "pending";
    const read = async (request: IncomingMessage) => {
        let text = "";
        for await (const chunk of request) text += chunk;
        return text.length === 0 ? null : JSON.parse(text);
    };
    const server: Server = createServer(async (request, response) => {
        const body = await read(request);
        const url = new URL(request.url ?? "/", "http://agency");
        calls.push({ method: request.method ?? "", path: url.pathname, body });
        const send = (status: number, value: unknown) => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(value));
        };
        if (request.headers["x-ghost-service-token"] !== TOKEN) return send(401, {});
        const path = url.pathname;
        if (path === "/internal/agency/attended/pending") {
            return send(200, intent === "pending" ? [run] : []);
        }
        if (path === "/internal/agency/attended/active") {
            const mine = intent === "acknowledged" && ["dispatched", "running"].includes(run.state);
            return send(200, mine ? [run] : []);
        }
        if (path === `/internal/agency/intents/${INTENT}/ack`) {
            intent = "acknowledged";
            run.ownerJobRef = (body as { ownerJobRef: string }).ownerJobRef;
            run.state = "dispatched";
            return send(200, { status: "Ok" });
        }
        if (path === `/internal/agency/runs/${RUN}/claim`) {
            run.state = "running";
            run.fence += 1;
            return send(200, {
                status: "Ok",
                runId: RUN,
                attempt: run.fence,
                fenceToken: run.fence,
            });
        }
        if (path === `/internal/agency/runs/${RUN}/complete`) {
            run.state = "proposed";
            return send(200, { status: "Ok" });
        }
        if (path.startsWith(`/internal/agency/runs/${RUN}/`)) return send(200, { status: "Ok" });
        return send(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address.");
    return {
        url: `http://127.0.0.1:${address.port}`,
        calls,
        run,
        paths: () => calls.map((call) => call.path),
    };
}

const dbCtx = (runtime: HappyAgentRuntime) => withAgentDatabase(runtime.ctx, runtime.database);

async function happy(agencyUrl: string, attendedOnly: boolean): Promise<HappyAgentRuntime> {
    const home = await mkdtemp(join(tmpdir(), "happy-orkest-owner-"));
    cleanups.push(
        async () =>
            await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    );
    const tokenFile = join(home, "orkest.token");
    await writeFile(tokenFile, TOKEN);
    const environment = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORKEST_AGENCY_URL: agencyUrl,
        ORKEST_AGENCY_TOKEN_FILE: tokenFile,
        ORKEST_WORKER_ID: "happy:test",
    };
    vi.stubEnv("HOME", home);
    const happyHome = join(home, ".happy");
    if (attendedOnly) {
        const path = (await ConfigModule.load(happyHome, { environment })).configuration.paths
            .globalConfigPath;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "[features]\nattended_only = true\n");
    }
    const providers = new AgentProviders();
    // An empty script: a turn the owner started on its own would fail the test.
    providers.add("gym", new ScriptedProvider([]), "codex");
    const runtime = await startHappyAgentRuntime({
        happyHome,
        environment,
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
    });
    cleanups.push(async () => await runtime.close());
    return runtime;
}

describe("Orkest attended owner", () => {
    it("opens one drafted, idle task per admitted run, keeps the lease, and completes it when the person ends it", async () => {
        const agency = await fakeAgency();
        const runtime = await happy(agency.url, true);
        const taskId = derivedId("t", RUN);
        const agentId = derivedId("a", RUN);

        await expect.poll(() => agency.run.state, { timeout: 20_000 }).toBe("running");
        const task = await runtime.modules.tasks.get(dbCtx(runtime), taskId);
        expect(task).toMatchObject({
            name: "WAR-7: Tighten the login check",
            status: "active",
            agentId,
        });
        // Acknowledged as that task, then claimed by this worker.
        expect(agency.calls.find((c) => c.path.endsWith("/ack"))?.body).toEqual({
            ownerJobRef: taskId,
        });
        expect(agency.calls.find((c) => c.path.endsWith("/claim"))?.body).toEqual({
            workerId: "happy:test",
            leaseSeconds: 120,
        });
        await expect
            .poll(() => agency.calls.find((c) => c.path.endsWith("/publish"))?.body, {
                timeout: 10_000,
            })
            .toMatchObject({
                fence: 1,
                eventType: "attended.session_opened",
                payload: { taskId, agentId },
            });

        // The composer holds the work item and the session's mode; nothing has run.
        const config = await runtime.system.config(dbCtx(runtime), agentId);
        expect(config?.metadata?.["draft"]).toMatchObject({
            providerId: "codex",
            modelId: "codex-cli/gpt-6.1-sol",
            permissionMode: "read_only",
            text: "Orkest work item WAR-7: Tighten the login check\n\nThe login check accepts an expired session.",
        });
        expect(runtime.modules.orkest.status).toMatchObject({ state: "running", sessions: 1 });

        // A repeated delivery of the same run finds the same task instead of a second one.
        expect(
            (
                await runtime.modules.tasks.createWithResult(dbCtx(runtime), {
                    id: taskId,
                    agentId,
                    workspaceId: derivedId("w", RUN),
                })
            ).created,
        ).toBe(false);

        agency.run.endRequestedAt = new Date().toISOString();
        await expect.poll(() => agency.run.state, { timeout: 20_000 }).toBe("proposed");
        expect(agency.calls.find((c) => c.path.endsWith("/complete"))?.body).toEqual({
            fence: 1,
            proposed: true,
            consumed: 1,
            reason: "ended by a person",
        });
        expect((await runtime.modules.tasks.get(dbCtx(runtime), taskId))?.status).toBe("archived");
        expect(runtime.modules.orkest.status.sessions).toBe(0);
    }, 60_000);

    it("refuses to own Orkest runs on an installation that may start work by itself", async () => {
        const agency = await fakeAgency();
        const root = await mkdtemp(join(tmpdir(), "happy-orkest-refuse-"));
        cleanups.push(async () => await rm(root, { recursive: true, force: true }));
        const tokenFile = join(root, "orkest.token");
        await writeFile(tokenFile, TOKEN);
        vi.stubEnv("ORKEST_AGENCY_URL", agency.url);
        vi.stubEnv("ORKEST_AGENCY_TOKEN_FILE", tokenFile);
        const config = await testConfigRootedAt(root, "[features]\nattended_only = false\n");
        expect(config.orkestAgency).toMatchObject({ url: agency.url, token: TOKEN });
        const module = new OrkestModule(config, {} as never);
        cleanups.push(async () => await module.close());
        const db = moduleDatabase([], "orkest-refuse");
        cleanups.push(() => db.close());
        await db.ready;
        await module.beforeStart(db.context, {} as never).afterStart?.(db.context, {} as never);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect(agency.calls).toEqual([]);
        expect(module.status).toMatchObject({
            state: "refused",
            lastError: "Orkest sessions need [features] attended_only = true.",
        });
    }, 30_000);

    it("stays off without an agency URL or a readable token", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-orkest-off-"));
        cleanups.push(async () => await rm(root, { recursive: true, force: true }));
        vi.stubEnv("ORKEST_AGENCY_URL", "http://127.0.0.1:9");
        vi.stubEnv("ORKEST_AGENCY_TOKEN_FILE", join(root, "missing.token"));
        const config = await testConfigRootedAt(root, "[features]\nattended_only = true\n");
        expect(config.orkestAgency).toBeUndefined();
        expect(new OrkestModule(config, {} as never).status.state).toBe("disabled");
    });
});
