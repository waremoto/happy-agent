// GHO-205.3.2 red stub: exports present, wrong answers.
import type { OrkestSessionAnswer, OrkestSessionCall } from "./OrkestSessionClient.js";
export interface MainDocSeen {
    readonly path: string;
    readonly rev: string;
}
export interface MainDocFocus {
    readonly path: string;
    readonly rev: string;
    readonly text: string;
    readonly changed: boolean;
    readonly changes: readonly unknown[] | null;
    readonly readOnly: boolean;
}
export const MAIN_DOC_SEEN_KEY = "orkest.mainDoc.seen";
export function mainDocChangeNote(_s: MainDocSeen, _f: MainDocFocus): string {
    return "";
}
export async function mainDocTurn(_d: {
    tool: (
        name: "focus",
        call: OrkestSessionCall,
        args: Record<string, unknown>,
    ) => Promise<OrkestSessionAnswer>;
    call: OrkestSessionCall;
    read: () => Promise<MainDocSeen | undefined>;
    write: (s: MainDocSeen) => Promise<void>;
}): Promise<string | null> {
    return "x";
}
export function mainDocOpenPath(
    _a: OrkestSessionAnswer | null,
    _p: readonly string[],
): string | undefined {
    return "x";
}
