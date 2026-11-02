import { describe, expect, it } from "vitest";

import { claudeCodeAgent } from "@/vendors/foreignAgents/claudeCodeAgent.js";
import { codexCliAgent } from "@/vendors/foreignAgents/codexCliAgent.js";

describe("native agents' permission options", () => {
    it("lets Claude Code ask about writes in Read only only when a person answers", () => {
        const options = claudeCodeAgent.profile!.permissionOptions!;
        expect(options("read_only", false)).toEqual([{ configId: "mode", value: "plan" }]);
        expect(options("read_only", true)).toEqual([{ configId: "mode", value: "default" }]);
        expect(options("workspace_write", true)).toEqual([
            { configId: "mode", value: "acceptEdits" },
        ]);
        expect(options("auto", true)).toEqual([{ configId: "mode", value: "auto" }]);
        expect(options("full_access", true)).toEqual([
            { configId: "mode", value: "bypassPermissions" },
        ]);
    });

    it("lets Codex ask only in Read only and Workspace write, and only when a person answers", () => {
        const policy = (mode: Parameters<typeof options>[0], asks: boolean) =>
            options(mode, asks).find((option) => option.configId === "approval_policy")?.value;
        const options = codexCliAgent.profile!.permissionOptions!;
        expect(policy("read_only", true)).toBe("on-request");
        expect(policy("workspace_write", true)).toBe("on-request");
        expect(policy("read_only", false)).toBe("never");
        expect(policy("auto", true)).toBe("never");
        expect(policy("full_access", true)).toBe("never");
        expect(options("read_only", true)[0]).toEqual({ configId: "mode", value: "read-only" });
    });
});
