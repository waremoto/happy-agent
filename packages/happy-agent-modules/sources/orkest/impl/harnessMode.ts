// GHO-207.2 red stub: harness mode never switches on and never allows (the tests define the behaviour).
export const HARNESS_MODE_FILE = ".orkest/harness-mode.json";

export interface HarnessModeFile {
    readonly enabled: boolean;
    readonly owners?: readonly string[];
    readonly problem?: string;
}

export function parseHarnessModeFile(_committed: string | undefined): HarnessModeFile {
    return { enabled: false };
}

export function starterOf(_startedBy: unknown): string | undefined {
    return undefined;
}

export function harnessModeApplies(_input: {
    readonly file: HarnessModeFile;
    readonly permissionMode: string;
    readonly startedBy: unknown;
}): boolean {
    return false;
}

export interface HarnessModeQuestion {
    readonly provider: "claude" | "codex";
    readonly action: string;
    readonly input: unknown;
}

export function harnessModeAllows(_repoPath: string, _question: HarnessModeQuestion): boolean {
    return false;
}
