# Local event logs and read-only dashboard

Available starting in **version 0.2.0**; not part of version 0.1.3. Validation status is tracked in [README](../README.md). This is observation, not orchestration, a durable task journal, or proof of agent liveness.

## Opening the dashboard

Coordinator startup automatically binds a separate HTTP listener to `127.0.0.1` on an OS-selected port, writes the actual bound port to its shared coordinator entry as `dashboardPort`, and prints the local dashboard URL in Pi. Open that exact URL in a local browser. No browser is opened automatically. Workers write local event metadata but do not start dashboard listeners. Extension teardown closes the dashboard and its active connections; a later startup can use a different URL.

`dashboardPort` is optional and coordinator-only, an integer from 1 through 65535. Existing configuration without it remains valid. It is **not the messaging `port`** and does not change agent-message routing. The saved port is last-known metadata; it is not a requested bind port or a guarantee that any process is listening.

Configured coordinators and workers can call existing `intercom_list` to obtain top-level `dashboardUrl`, derived as `http://127.0.0.1:<saved dashboardPort>/`, or `null` if the coordinator has no saved dashboard port. The result retains `version`, `multiplexer` and `agents`. Listing only reads shared config: it does not probe, start, rebind or control the dashboard. A previously saved address remains after closure or startup failure, so a non-null URL is **not proof of dashboard liveness**. No new tool or dashboard control is added.

The URL is announced only after the new bound port has been saved and startup lifecycle checks still pass. If saving fails, the newly created dashboard is closed and a local error is shown; Intercom messaging remains available. The previous saved URL, if any, is not cleared and can be stale. Shutdown likewise leaves the saved field intact. Startup does not request or reuse the saved dashboard port.

The dashboard polls its read-only snapshot endpoint every three seconds after the preceding request settles, with an eight-second client timeout. It has no agent controls, assignment forms, send buttons, stop/close, recovery actions, or retry controls. Its refresh loop only rereads telemetry; it does not resend Intercom messages or probe workers.

### Reading the screen

- **Configured agents:** names, responsibilities, saved endpoints and Pi session IDs come from shared configuration. Saved entries do not establish whether a process exists. Responsibility is not an assignment.
- **Observed busy / observed idle:** the most recent `runtime.ready` or `host.activity` event in the retained window for that Pi session. The event's own timestamp and age are shown. `status.received` is not attributed to its writer as that writer's busy state; its `busy` value describes the reporting peer.
- **Stale evidence:** an observation older than 60 seconds. It does not mean offline: a legitimately idle host may emit no new activity. **Unknown** means no eligible observation in the retained window, not idle or unavailable. Future-dated observations are marked clock-uncertain.
- **Exchange ledger:** newest metadata first; filter by agent (including either side of an exchange), event type, or errors. Expand a row for allowlisted fields and correlation. Receipt, submission, and host activity are separate facts, not task-completion states.
- **Disconnected / partial snapshot:** the banner states the problem. Previously received data may remain visible and continues to age; it must not be treated as current process status. An empty timeline does not prove no activity occurred.

The UI uses local HTML/CSS/JavaScript, with no CDN or remote fonts. Event/config text is inserted as text, never as executable HTML. It displays selected roster fields, not a raw config dump.

## Privacy and event contract

Logs live under `<coordinator-root>/.pi-intercom/logs/`. They are **metadata-only**: there is no prompt-body logging mode in this implementation. Message bodies, tool arguments/results, credentials, raw error messages/stacks, and responsibility text are not copied into log events. The dashboard separately reads configured names and responsibilities for its roster; do not put secrets in those fields. Metadata can still be sensitive: session IDs, human labels, endpoints, timings and communication patterns may identify your work. Keep logs local and do not commit or publish them. Shared `config.json` remains the source-controlled configuration; logging does not move IDs or ports out of it.

Version 1 event fields:

| Field | Meaning |
|---|---|
| `version` | `1` |
| `timestamp` | UTC ISO observation time, not a global ordering guarantee |
| `sessionId` | Actual Pi agent/session identity |
| `writerId` | Ephemeral UUID for this log writer/file group only; **not a new agent or transport identity** |
| `event` | Allowlisted event type |
| `peerSessionId`, `peerName` | Optional peer metadata |
| `correlationId` | Optional identifier for one transport attempt, not a task, reply promise or completion token |
| `kind`, `operation`, `role`, `outcome` | Optional allowlisted metadata values |
| `busy`, `port` | Optional observed boolean / port |
| `errorCode` | Optional fixed safe error label; no raw exception text |

Current event types: `runtime.starting`, `runtime.ready`, `runtime.closed`, `runtime.failed`, `config.changed`, `config.reloaded`, `transport.send`, `transport.receipt`, `transport.failed`, `transport.received`, `transport.rejected`, `registration.received`, `status.received`, `launch.result`, `host.submission`, `host.activity`, `host.ui_prompt`.

A sender generates an optional wire-envelope `correlationId` for each send; the receiver can record it too. Legacy envelopes without it are accepted. It provides trace correlation only: no deduplication, replay, durable delivery or synchronous request/reply behavior is introduced.

### What the records do not establish

- `transport.receipt` / `http_receipt` means the sender saw HTTP acceptance. It does **not** prove Pi accepted or queued the input, nor that a model turn or assignment completed.
- `host.submission` with `attempted`, `returned` or `failed` records a synchronous host call. Pi 0.84.4's void `sendUserMessage` binding can report an asynchronous manual-compaction rejection only locally after HTTP acceptance. Logging does not fix or reliably observe that asynchronous rejection.
- `host.activity` `started`/`settled` observes host activity, not a particular message's result. Busy snapshots are not availability guarantees.
- `launch.result` does not establish agent readiness. `host.ui_prompt` does not authorize work. Neither monitoring nor errors trigger orchestration.
- Stop/close remain disabled. Telemetry does not add cancellation, forced shutdown, retries, recovery or rollback.

## Storage bounds and failure behavior

Each writer appends newline-delimited JSON to `writer-<UUID>.jsonl` and rotates through `.jsonl.1` and `.jsonl.2`.

| Bound | Policy |
|---|---|
| Active/rotated file size | 1 MiB each, up to three data files per writer |
| Event size | At most 4 KiB per JSONL record |
| In-memory writer queue | At most 256 queued entries plus one in-flight entry; excess records are dropped |
| Closed-group retention | Seven days; cleanup can remove older closed groups earlier to target 32 MiB aggregate storage |
| Cleanup scan | At most 4096 directory entries per maintenance pass |
| Maintenance | Coordinator only, at startup and every 60 seconds |

A graceful writer close renames its active file to `.jsonl.closed`; that suffix is the cleanup eligibility marker, not a live process probe. Cleanup removes only closed writer groups, oldest first. Active and crash-orphan groups are left untouched. The 32 MiB directory target is therefore **best effort, not a hard disk cap**, especially if active/orphan groups or scan limits dominate. Filesystem failures may leave files behind.

Logging is non-authoritative and best effort. Discovery failures before root resolution and invalid HTTP envelopes rejected before runtime handling are not emitted as runtime log events. Sanitization/size/queue failures can discard observations. An append/rotation I/O failure disables that writer and drops queued records without retrying or failing Intercom communication. Maintenance failures are ignored by the communication path. Ordinary record/send/delivery operations never await logging I/O. During teardown, the runtime invalidates its lifecycle and closes its HTTP endpoint before waiting at most **250 ms** for logger shutdown. Concurrent close callers share the same close operation. This is not a guaranteed flush: timed-out I/O cannot be cancelled and may finish later.

The writer refuses pre-existing symbolic links at `.pi-intercom` or its `logs` directory; these checks are best effort, not race-proof protection against a hostile filesystem. The dashboard cannot certify that logging was complete or that a quiet writer is healthy; inspect local storage when diagnosing missing evidence. Logs are not fsynced as a durable delivery journal.

## HTTP snapshot boundary

Only the coordinator exposes these GET routes:

| Route | Response |
|---|---|
| `/` | Local `dashboard/index.html` |
| `/app.js`, `/style.css` | Explicitly allowlisted local assets |
| `/api/snapshot` | Sanitized JSON snapshot |

Snapshot shape:

```text
{ version: 1, generatedAt, staleAfterMs: 60000,
  config: { multiplexer, agents: [selected validated roster fields] } | null,
  events: [sanitized v1 events, oldest first], truncated: boolean,
  errors: [fixed safe labels] }
```

Reads are bounded: config at most 1 MiB and 256 agents; scan at most 512 log-directory entries, select up to 32 newest matching files among those scanned (not necessarily the globally newest files in an oversized directory), tail at most 128 KiB per file and 2 MiB total, and return at most 500 latest events. `truncated` indicates bounded omissions, not complete history. Unsupported, malformed or partial records are ignored. Reads can overlap rotation and are not a transactional global snapshot.

Partial snapshots return HTTP 200 with `config_unavailable`, `logs_unavailable` and/or `log_read_failed` labels; no raw read errors or paths are returned. Unknown routes (including query variants) return 404; non-GET requests return 405; rejected Host/Origin/cross-site requests return 403; overload or static-asset failures return 503. The listener admits at most eight active requests and 16 connections. Concurrent snapshot requests share the pending read, not a worker probe.

The backend rejects linked/redirected config, log and asset path components and serves no arbitrary file route. It sets no-store, nosniff, same-origin-only content policy, no-referrer and frame-ancestor restrictions. These checks reduce exposure but are **not authentication or a security boundary against hostile local processes**; localhost remains trusted. Do not proxy or expose the dashboard remotely.

## Validation scope

See README for verified test results. Synthetic filesystem/HTTP/DOM fixtures do not prove actual Pi queue acceptance, live resume, host name persistence, or full interactive lifecycle correctness. No dashboard observation should be used to infer unobserved completion or availability.
