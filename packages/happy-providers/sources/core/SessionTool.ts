import type { TSchema } from "@sinclair/typebox";

/** Lark grammar for OpenAI-style custom tool call syntax. */
export interface SessionToolLarkGrammar {
    readonly type: "lark";
    readonly grammar: string;
}

/** Tool definition supplied to a session. Mapping to provider wire format is vendor-specific. */
export interface SessionTool {
    readonly name: string;
    readonly namespace?: string;
    /** Description of the containing namespace, when this tool is namespaced. */
    readonly namespaceDescription?: string;
    /**
     * Exact native tool descriptor for a call the provider owns and settles inside its response.
     *
     * Absence means the caller owns execution. Provider mappers pass this descriptor through
     * instead of deriving a native tool type from `name`.
     */
    readonly server?: { readonly type: string; readonly [key: string]: unknown };
    readonly description?: string;
    readonly parameters?: TSchema;
    /** Additional provider-owned discovery terms that describe this tool. */
    readonly searchKeywords?: readonly string[];
    /** Provider-neutral request to expose this tool through native tool discovery. */
    readonly defer?: boolean;
    /** Ignored by providers that do not support grammar-based tools. */
    readonly grammar?: SessionToolLarkGrammar;
    /**
     * Permission modes in which the host refuses this tool whatever its arguments. A foreign agent
     * that reaches the tool through the bridge is then refused at once, without asking a person to
     * allow what the host would refuse anyway. Absent means the host decides at execution.
     */
    readonly refusedInModes?: readonly ("read_only" | "workspace_write" | "auto" | "full_access")[];
}

export interface SessionToolsOptions {
    readonly tools?: readonly SessionTool[];
}
