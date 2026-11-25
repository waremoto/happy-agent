import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { nativeToolPermissionQuestion } from "../../sources/userInput/impl/nativeToolPermissionQuestion.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

/*
 * ORKEST-AGENCY 4.2c. In team mode a native tool's permission question (Claude Code or Codex asking
 * to run an action) belongs to the person whose task it is: another member answering it gets
 * `403 forbidden` and the question stays pending, so nobody else can allow an action in someone
 * else's session. A task nobody owns is the team owner's. The answer records who gave it.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllGlobals();
});

const PERMISSION = {
    provider: "claude",
    providerTitle: "Claude Code",
    action: "Write notes.txt",
    input: { file_path: "notes.txt" },
    inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

describe("who may answer a native tool permission question", () => {
    it("lets only the task's owner answer, and the team owner only for a task nobody owns", async () => {
        const { runtime, endpoint, token } = await start(true);
        const [alice, bob, carol] = await Promise.all(
            ["user_alice", "user_bob", "user_carol"].map(
                async (subject) => new HappyAgentClient({ endpoint, token: await token(subject) }),
            ),
        );
        const ids: string[] = [];
        for (const [client, name] of [
            [alice, "Alice"],
            [bob, "Bob"],
            [carol, "Carol"],
        ] as const) {
            const { profile } = await client!.getProfile();
            const saved = await client!.updateProfile({ name }, { ifMatch: profile.version });
            ids.push(saved.profile.userId!);
        }
        const [aliceId, bobId] = ids as [string, string, string];
        const ctx = withAgentDatabase(runtime.ctx.named("test.native-answer"), runtime.database);
        const owned = await runtime.modules.tasks.create(ctx, {
            name: "Bob's task",
            ownerUserId: bobId,
        });
        const orphan = await runtime.modules.tasks.create(ctx, { name: "Nobody's task" });
        const { input, permissionRequest } = nativeToolPermissionQuestion(PERMISSION);
        const ask = async (agentId: string) =>
            await runtime.modules.userInput.askForPermission(
                ctx,
                agentId,
                input,
                permissionRequest,
            );
        const answer = (client: HappyAgentClient, agentId: string, question: { id: string }) =>
            client.answerQuestion(
                agentId as never,
                question.id as never,
                {
                    answers: { approval: ["Allow once"] },
                } as never,
            );
        const status = async (agentId: string, id: string) =>
            (await runtime.modules.userInput.get(ctx, agentId, id))?.status;

        // Bob's task: another member and the team owner are refused, and nothing is answered.
        const asked = await ask(owned.agentId);
        await expect(answer(carol!, owned.agentId, asked)).rejects.toMatchObject({
            status: 403,
            code: "forbidden",
        });
        await expect(answer(alice!, owned.agentId, asked)).rejects.toMatchObject({
            status: 403,
            code: "forbidden",
        });
        expect(await status(owned.agentId, asked.id)).toBe("pending");
        await answer(bob!, owned.agentId, asked);
        expect(await runtime.modules.userInput.get(ctx, owned.agentId, asked.id)).toMatchObject({
            status: "answered",
            answeredBy: bobId,
        });

        // A task nobody owns: only the team owner may answer.
        const orphaned = await ask(orphan.agentId);
        await expect(answer(bob!, orphan.agentId, orphaned)).rejects.toMatchObject({
            status: 403,
            code: "forbidden",
        });
        expect(await status(orphan.agentId, orphaned.id)).toBe("pending");
        await answer(alice!, orphan.agentId, orphaned);
        expect(await runtime.modules.userInput.get(ctx, orphan.agentId, orphaned.id)).toMatchObject(
            {
                status: "answered",
                answeredBy: aliceId,
            },
        );
    }, 60_000);
});

async function start(team: boolean): Promise<{
    runtime: HappyAgentRuntime;
    endpoint: string;
    token: (subject: string) => Promise<string>;
}> {
    const root = await mkdtemp(join(tmpdir(), "task-api-"));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    const happyHome = join(root, ".happy");
    const configPath = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "happy.toml",
    );
    await mkdir(dirname(configPath), { recursive: true });
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
    if (team) {
        await writeFile(
            configPath,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                'workos_organization_id = "org_tasks"',
                'owner_workos_user_id = "user_alice"',
            ].join("\n"),
        );
        const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "tasks", use: "sig" };
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
            String(input).includes("api.workos.com/sso/jwks/")
                ? Promise.resolve(Response.json({ keys: [jwk] }))
                : nativeFetch(input, init),
        );
    }
    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider([]), "codex");
    let server: Server | undefined;
    let endpoint = "";
    const runtime = await startHappyAgentRuntime({
        happyHome,
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
        onPrepared: async (prepared) => {
            server = createServer((request, response) => {
                void prepared.api.handleRequest(prepared.context("test.http"), request, response);
            });
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing address.");
            endpoint = `http://127.0.0.1:${address.port}`;
        },
    });
    cleanups.push(async () => {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await runtime.close();
    });
    return {
        runtime,
        endpoint,
        token: async (subject) =>
            await new SignJWT({ client_id: clientId, org_id: "org_tasks", sid: "session_tasks" })
                .setProtectedHeader({ alg: "RS256", kid: "tasks" })
                .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey),
    };
}
