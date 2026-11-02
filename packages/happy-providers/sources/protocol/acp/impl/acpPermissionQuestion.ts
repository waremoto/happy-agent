import { createHash } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";

import type { AcpPermissionQuestion } from "@/protocol/acp/AcpProvider.js";

/**
 * The person-facing form of one ACP permission request: what the agent described and the exact
 * input it will run with, pinned by a digest so an answer can only ever allow that input.
 */
export function acpPermissionQuestion(params: acp.RequestPermissionRequest): AcpPermissionQuestion {
    const input = params.toolCall.rawInput;
    const title = params.toolCall.title?.trim();
    return {
        action: title === undefined || title.length === 0 ? "An unnamed action" : title,
        input,
        inputDigest: `sha256:${createHash("sha256")
            .update(canonicalJson(input ?? null))
            .digest("hex")}`,
    };
}

/** JSON with object keys sorted at every depth, so equal inputs always digest the same. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
