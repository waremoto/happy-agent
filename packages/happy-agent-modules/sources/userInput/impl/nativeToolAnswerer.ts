/**
 * Who may answer a native tool's permission question in team mode (ORKEST-AGENCY 4.2c).
 *
 * The question asks to run an action in one person's session, so only that person may allow or
 * deny it: the owner of the agent's task. A task nobody owns is the team owner's. An agent outside
 * any task keeps the ordinary rule (any onboarded member). Standalone mode never calls this: its
 * one person answers everything.
 */
export function mayAnswerNativeToolQuestion(
    answerer: { readonly id: string; readonly isOwner: boolean } | undefined,
    task: { readonly ownerUserId?: string | null | undefined } | undefined,
): boolean {
    if (task === undefined) return true;
    if (answerer === undefined) return false;
    const owner = task.ownerUserId ?? undefined;
    return owner === undefined ? answerer.isOwner : owner === answerer.id;
}
