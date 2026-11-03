import type { AnyAgentTool } from "@slopus/happy-agent-base";

/**
 * Tools an attended-only installation does not offer. Such an installation is hosted for an
 * admission service (Orkest), which grants secrets, integrations and outside effects itself; these
 * tools would reach the installation-wide catalog or act outside the work item, and each one asking
 * the person first is not a boundary. Reads that stay inside the conversation remain.
 */
export const ATTENDED_ONLY_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
    // the installation-wide secret catalog
    "create_secret",
    "update_secret",
    "attach_secret",
    "detach_secret",
    "list_secrets",
    "reference_secret",
    // MCP configuration
    "configure_mcp_server",
    "reload_mcp_servers",
    // bots and exported bots (messaging bots is already refused when attended-only)
    "send_bot_message",
    "create_bot",
    "update_bot_settings",
    "set_bot_name",
    "set_bot_avatar",
    "approve_exported_bot_user",
    "deny_exported_bot_user",
    "remove_exported_bot",
    "set_telegram_exported_bot",
    "set_bridge_exported_bot",
    // calendar writes
    "create_calendar_event",
    "update_calendar_event",
    "delete_calendar_event",
]);

/** The final tool list with every attended-only hidden tool removed. */
export function attendedToolScope(tools: readonly AnyAgentTool[]): readonly AnyAgentTool[] {
    return tools.filter((tool) => !ATTENDED_ONLY_HIDDEN_TOOLS.has(tool.name));
}
