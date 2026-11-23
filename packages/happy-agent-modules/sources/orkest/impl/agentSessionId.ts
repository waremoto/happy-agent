import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** What a commit trailer can carry (the dashboard's `agentOrigin` rule for `Session-Id:`). */
const TRAILER_SAFE = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * GHO-196 — the harness session a Happy agent's conversation is in now, Claude Code or Codex, for a proposal's
 * `agentSessionId` (it becomes the accepted commit's `Session-Id:`). The newest
 * `<agentHome>/foreign-agents/<harness>[/<provider>]/sessions/<agentId>.json` record across routes is the current
 * one (the same layout `claudeSessionIdFor` reads); its `acpSessionId` is Claude's session id or Codex's thread id.
 * Read-only and best effort: anything unreadable is absent.
 */
export async function agentSessionIdFor(
    agentHome: string,
    agentId: string,
): Promise<{ harness: string; id: string } | undefined> {
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
                // No record on this route.
            }
        }
    }
    if (newest === undefined) return undefined;
    try {
        const record = JSON.parse(await readFile(newest.path, "utf8")) as {
            acpSessionId?: unknown;
        };
        const id = record.acpSessionId;
        return typeof id === "string" && TRAILER_SAFE.test(id)
            ? { harness: newest.harness, id: id.toLowerCase() }
            : undefined;
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
