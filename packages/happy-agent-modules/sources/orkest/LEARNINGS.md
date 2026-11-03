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
