import type { UserInputAskInput, UserInputPermissionRequest } from "../UserInputRequest.js";
import {
    MAX_USER_INPUT_CONTEXT_CHARACTERS,
    MAX_USER_INPUT_PERMISSION_ACTION_CHARACTERS,
    MAX_USER_INPUT_QUESTION_CHARACTERS,
} from "../UserInputRequest.js";

/** The only answer that allows a native agent's action. */
export const NATIVE_TOOL_ALLOW = "Allow once";
export const NATIVE_TOOL_DENY = "Deny";
export const NATIVE_TOOL_QUESTION_ID = "approval";

/** One action a native coding agent asks to take, as the person is shown it. */
export interface NativeToolPermission {
    readonly provider: "claude" | "codex";
    readonly providerTitle: string;
    readonly action: string;
    readonly input: unknown;
    readonly inputDigest: string;
}

/**
 * The question and permission marker for one native action. The prompt names the agent and the
 * action; the context carries the exact input it will run with, so the person approves what runs
 * and the digest pins it.
 */
export function nativeToolPermissionQuestion(permission: NativeToolPermission): {
    readonly input: UserInputAskInput;
    readonly permissionRequest: UserInputPermissionRequest;
} {
    const action = bound(permission.action, MAX_USER_INPUT_PERMISSION_ACTION_CHARACTERS);
    const inputText =
        permission.input === undefined ? "(no input)" : JSON.stringify(permission.input, null, 2);
    const context = bound(
        [
            `**${permission.providerTitle}** wants to take an action its permission mode does not allow.`,
            "It runs only if you allow it, and only this once, with exactly this input:",
            "",
            "```json",
            inputText,
            "```",
            "",
            `Input digest: \`${permission.inputDigest}\``,
        ].join("\n"),
        MAX_USER_INPUT_CONTEXT_CHARACTERS,
    );
    return {
        input: {
            context,
            questions: [
                {
                    id: NATIVE_TOOL_QUESTION_ID,
                    header: "Permission",
                    question: bound(
                        `${permission.providerTitle} wants to: ${action}`,
                        MAX_USER_INPUT_QUESTION_CHARACTERS,
                    ),
                    options: [
                        { label: NATIVE_TOOL_ALLOW, description: "Run this one action." },
                        { label: NATIVE_TOOL_DENY, description: "Refuse it." },
                    ],
                    multiSelect: false,
                },
            ],
        } as UserInputAskInput,
        permissionRequest: {
            source: "native_tool",
            provider: permission.provider,
            providerTitle: bound(permission.providerTitle, 128),
            action,
            inputDigest: permission.inputDigest,
        },
    };
}

function bound(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
