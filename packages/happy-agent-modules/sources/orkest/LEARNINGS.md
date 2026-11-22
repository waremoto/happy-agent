# Orkest owner learnings

## The owner reuses tasks, so an Orkest session is an ordinary Happy conversation

An attended Orkest run becomes a Happy task created with a drafted mode and no opening text. That
is the existing "seeds an idle draft" path, so nothing runs until the person sends a message, and
the renderer shows the session like any other task with no renderer change. The task, workspace
and agent identities are derived from the run ID, so a repeated delivery (a lost acknowledgement,
a restart between create and ack) finds the same task instead of opening a second one.

## Ending is the owner's completion, never the requester's

Orkest's kernel only lets the fence holder complete a run, and a cancelled running run parks as
uncertain until a person reconciles it. So a person ending a session in Orkest records a request;
this owner sees it on its next poll, archives the task (which aborts any turn) and completes the
run as proposed with one session consumed. The session budget counts sessions, not tokens, so the
usage is known and the scope is freed at once.

## No local state: Orkest's active feed is the recovery record

After a daemon restart the module asks Orkest for the runs this worker owns and reclaims each one.
The claim bumps the fence, so a heartbeat from the previous process can no longer count. Nothing
about Orkest sessions is stored in Happy's database beyond the tasks themselves.

## Settings come from the environment, not happy.toml

`ORKEST_AGENCY_URL`, `ORKEST_AGENCY_TOKEN_FILE`, `ORKEST_WORKER_ID` and the optional
`ORKEST_WORKER_TOKEN_FILE` are read by `ConfigModule.orkestAgency`. The worker token is this
daemon's own (one daemon per agency per machine); with it Orkest scopes every owner call to that
agency, and a named but unreadable file turns the owner off rather than falling back to the
unscoped lane. Keeping them out of the configuration file kept `API.md` and
`GET /v0/config` unchanged. The module refuses to run unless `[features] attended_only = true`,
because an Orkest-hosted Happy that could start work itself would be a second scheduler.

## Attended-only hides tools at the final list, not per module

A live probe of an attended Read only session found about 90 Happy tools offered to the native
agent, including the installation-wide secret catalog, MCP configuration, bot messaging and
calendar writes; each asked the person first, but asking is not a boundary for an agency host.
The operator authorized removing them (2026-11-03). This module's `overrideTools` filters the
agent's final tool list when `attended_only` is on, so the tool bridge a native harness reads
offers the same reduced set. One list in one place, tested against the real tool factories so a
renamed tool fails the test instead of silently reappearing.

## A runtime test without attended-only does not close cleanly with an empty script

Happy's own background agents start turns when attended-only is off; with an empty
`ScriptedProvider` those turns never settle and `runtime.close()` times out. The refusal case is
therefore tested on the module alone.

## OrkestAfkModule: the unattended owner is a second module, not a mode of the first

Unattended (AFK) runs come from a separate Father lane (`/internal/agency/afk/*`) with its own
settings, so `OrkestAfkModule` sits beside `OrkestModule` rather than branching inside it. It is
enabled by `ConfigModule.orkestAfk`: `ORKEST_AFK_URL`, `ORKEST_AFK_TOKEN_FILE`,
`ORKEST_AFK_WORKER_TOKEN_FILE` (required: the AFK lane refuses tokenless calls, and a named but
unreadable file turns the module off instead of falling back), `ORKEST_AFK_MODEL`
(`<providerId>:<modelId>`, or a model id the catalog knows), and optional `ORKEST_AFK_WORKER_ID`
(default `happy-afk:<host>`), `ORKEST_AFK_WORK_ROOT` and `ORKEST_AFK_REPO`. Like the attended
owner it refuses unless `[features] attended_only = true`, and it also refuses a native-harness
model (`claude-code/`, `codex-cli/`, ...): such a harness runs its own tools, so no call of it could
reach `beforeToolCall` to be put to a person.

Identities are derived from the run with the salt `orkest-afk:` (`afkDerivedId`), never the
attended `orkest:` salt, and the task folder is `orkest_afk_<hash>`. That folder is the run's work
directory; `ORKEST_AFK_WORK_ROOT` turns it into a link to `<root>/<folder>`, and `ORKEST_AFK_REPO`
makes the directory a detached `git worktree` of the repository. Both steps are idempotent.

## The tool policy is a short read-only allowlist and an approval for everything else

Tool names are per vendor, so the allowlist names each vendor's read tools (`Read`, `Glob`,
`Grep`, `ReadMediaFile`, `read_file`, `list_dir`, `grep`, `view_image`). Any other call, shells
included, is asked about: the key is `${tool}:${sha256(stable JSON of the arguments)[0..32]}`, so a
retry or a call repeated after a restart asks Orkest with the same key and gets the stored row
back. An answered call is therefore never asked twice, and an approved one runs at once. The hook
polls the approval every 2 s and gives up, answering the model that nothing ran, when the run is
lost, stopped, or the process shuts down. The module sits after `PermissionsModule` in the module
order, so a call the mode refuses outright is never put to a person.

## A denial answers the model first and ends the run when the loop settles

Archiving the task from inside `beforeToolCall` would abort the turn before the model ever saw why
its call failed. Instead the denial is the call's error result ("A person declined this action ...
Stop."), every later call in that run is refused without asking, and `afterAgentSettled` ends the
run: archive, receipt, complete `approval_denied` / `declined`. A model that keeps going is ended
anyway after a minute. A stop request from the active feed archives at once, since nothing the
model says matters any more.

## The receipt is the run's record; progress lines are display-only

Before completing, the module publishes `afk.receipt` (`receipt.json`): the last assistant text as
the summary, every tool call with its input hash and decision, every approval with who answered it,
and the turn count. Progress lines are the module's own short texts (never tool inputs); start,
approval and end lines always go out, other lines at most every five seconds.

## Restart: reclaim, re-offer the brief by id, one continuation

Nothing is stored locally. After a restart the active feed lists the runs this worker holds; each
is claimed again (a higher fence, so the old process stops counting), the brief is re-offered under
its derived message id (Happy answers `existing`, never a second message), and one continuation
message derived from `${runId}:resume:${fence}` tells the model the worker restarted and that
interrupted calls did not run. `afterAgentSettled` is ignored while the module or the agent is
shutting down, so a restart never completes a run as failed.
