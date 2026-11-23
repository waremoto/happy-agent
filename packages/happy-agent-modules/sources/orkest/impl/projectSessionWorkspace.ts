/** GHO-196.1.3 — stub. */
export function workingCopyPath(_taskPath: string, _docPath: string): string {
    return "";
}
export async function writeWorkingCopy(
    _t: string,
    _p: string,
    _text: string,
    _rev: string | null,
): Promise<void> {}
export async function readWorkingCopy(_t: string, _p: string): Promise<string | undefined> {
    return undefined;
}
export async function baseFor(_t: string, _p: string): Promise<string | null | undefined> {
    return undefined;
}
export async function setBase(_t: string, _p: string, _rev: string | null): Promise<void> {}
export async function refreshStale(
    _t: string,
    _p: string,
    _rev: string,
    _text: string,
): Promise<void> {}
