import { describe, expect, it } from "vitest";

import { toolTitle } from "@/vendors/claudeAgent/impl/claudeAgentUpdates.js";

describe("Claude tool titles", () => {
    it("names what a tool touches, so a person approves more than a tool name", () => {
        expect(toolTitle("Write", { file_path: "/w/approved.txt", content: "ok" })).toBe(
            "Write: /w/approved.txt",
        );
        expect(toolTitle("Bash", { command: "rm -rf build", description: "Clean" })).toBe(
            "Bash: rm -rf build",
        );
        expect(toolTitle("WebFetch", { url: "https://example.com" })).toBe(
            "WebFetch: https://example.com",
        );
    });

    it("keeps the bare name when the input says nothing, and Happy tools as Claude sees them", () => {
        expect(toolTitle("TodoWrite", { todos: [] })).toBe("TodoWrite");
        expect(toolTitle("mcp__happy__ask", { command: "x" })).toBe("mcp__happy__ask");
    });
});
