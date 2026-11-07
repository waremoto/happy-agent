import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudeSessionIdFor } from "../../sources/orkest/impl/claudeSessionId.js";

const AGENT = "a:0195f3a0/run";
const homes: string[] = [];

afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function home(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "happy-claude-session-"));
    homes.push(path);
    return path;
}

async function record(agentHome: string, route: string[], acpSessionId: unknown, at: number) {
    const directory = join(agentHome, "foreign-agents", ...route, "sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${encodeURIComponent(AGENT)}.json`);
    await writeFile(
        path,
        JSON.stringify({ acpSessionId, cwd: "/w", consumed: 1, fingerprint: "f" }),
    );
    await utimes(path, at, at);
}

describe("claudeSessionIdFor", () => {
    it("is undefined before any session record exists", async () => {
        expect(await claudeSessionIdFor(await home(), AGENT)).toBeUndefined();
    });

    it("reads the Claude Code route's record, with or without a provider directory", async () => {
        const plain = await home();
        await record(plain, ["claude_code"], "5B0C6A1E-3F2D-4C8E-9A71-0D2E4F6B8C13", 1_000);
        expect(await claudeSessionIdFor(plain, AGENT)).toBe("5b0c6a1e-3f2d-4c8e-9a71-0d2e4f6b8c13");

        const routed = await home();
        await record(
            routed,
            ["claude_code", "claude_alex_acme"],
            "9e4d2c1b-7a6f-4e3d-8b2a-1c0f9e8d7a65",
            1_000,
        );
        expect(await claudeSessionIdFor(routed, AGENT)).toBe(
            "9e4d2c1b-7a6f-4e3d-8b2a-1c0f9e8d7a65",
        );
    });

    it("follows the newest record, and has no Claude session when the newest is another harness", async () => {
        const agentHome = await home();
        await record(agentHome, ["claude_code"], "5b0c6a1e-3f2d-4c8e-9a71-0d2e4f6b8c13", 1_000);
        await record(
            agentHome,
            ["claude_code", "claude_alex_acme"],
            "9e4d2c1b-7a6f-4e3d-8b2a-1c0f9e8d7a65",
            2_000,
        );
        expect(await claudeSessionIdFor(agentHome, AGENT)).toBe(
            "9e4d2c1b-7a6f-4e3d-8b2a-1c0f9e8d7a65",
        );

        await record(
            agentHome,
            ["codex_cli", "codex"],
            "0195f3a0-0000-7000-8000-000000000001",
            3_000,
        );
        expect(await claudeSessionIdFor(agentHome, AGENT)).toBeUndefined();
    });

    it("ignores a record whose id is not a UUID, or that is not JSON", async () => {
        const agentHome = await home();
        await record(agentHome, ["claude_code"], "../../etc/passwd", 1_000);
        expect(await claudeSessionIdFor(agentHome, AGENT)).toBeUndefined();

        const broken = await home();
        const directory = join(broken, "foreign-agents", "claude_code", "sessions");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${encodeURIComponent(AGENT)}.json`), "{not json");
        expect(await claudeSessionIdFor(broken, AGENT)).toBeUndefined();
    });
});
