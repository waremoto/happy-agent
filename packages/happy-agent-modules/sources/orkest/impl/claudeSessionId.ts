import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** The foreign-agent harness directory Claude Code routes keep their state in. */
const CLAUDE_HARNESS = "claude_code";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Claude Code session id an agent's conversation currently continues in, or `undefined`.
 *
 * Every foreign-agent route keeps one record per agent at
 * `<agentHome>/foreign-agents/<harness>[/<provider>]/sessions/<agentId>.json` with the ACP session it
 * continues (`acpSessionId`). For Claude Code that id is the Claude session id itself: the Agent SDK is
 * started with it (`claudeAgentConnect`), so it names the transcript Claude writes. A record is written
 * once the session has answered a prompt, and replaced when Happy opens a fresh session, so the newest
 * record across routes is the current one; a person who switched to another harness has a newer record
 * elsewhere, and then there is no current Claude session.
 *
 * Read-only and best effort: any unreadable directory or record is treated as absent.
 */
export async function claudeSessionIdFor(
    agentHome: string,
    agentId: string,
): Promise<string | undefined> {
    const root = join(agentHome, "foreign-agents");
    const file = `${encodeURIComponent(agentId)}.json`;
    let newest: { path: string; harness: string; modified: number } | undefined;
    for (const harness of await directories(root)) {
        const routes = [
            join(root, harness),
            ...(await directories(join(root, harness)))
                .filter((name) => name !== "sessions")
                .map((name) => join(root, harness, name)),
        ];
        for (const route of routes) {
            const path = join(route, "sessions", file);
            try {
                const modified = (await stat(path)).mtimeMs;
                if (newest === undefined || modified > newest.modified)
                    newest = { path, harness, modified };
            } catch {
                // No record for this agent on this route.
            }
        }
    }
    if (newest === undefined || newest.harness !== CLAUDE_HARNESS) return undefined;
    try {
        const record = JSON.parse(await readFile(newest.path, "utf8")) as {
            acpSessionId?: unknown;
        };
        const id = record.acpSessionId;
        return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

async function directories(path: string): Promise<string[]> {
    try {
        return (await readdir(path, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}
