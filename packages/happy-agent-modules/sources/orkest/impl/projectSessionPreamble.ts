/** GHO-196.1.3 — stub. */
export interface ProjectSessionPreambleInput {
    readonly title: string;
    readonly scope: {
        readonly kind: "project" | "doc";
        readonly projectId: string;
        readonly path: string | null;
    };
    readonly permissionMode: string;
    readonly focus?: { readonly path: string; readonly rev: string; readonly text: string };
    readonly docs: number | null;
}
export function projectSessionPreamble(_input: ProjectSessionPreambleInput): string {
    return "";
}
