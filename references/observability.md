# Local observations and terminal monitor

Intercom's terminal monitor is a standalone Node/pi-tui process above the coordinator in Herdr. It reads local configuration and metadata logs; it is not an agent, scheduler, durable task journal, or proof of liveness. Included in npm release 0.4.1, replacing the browser dashboard. See [README](../README.md) for installation and validation scope.

## Terminal-first monitoring

Coordinator startup checks its saved monitor ownership and either preserves the existing pane or creates one above the coordinator. Workers do not create monitors. The pane is named `Intercom monitor`; its generic label alone is not proof of ownership. Machine-local `monitor-*.json` files record the coordinator/workspace/pane identities and partial-launch state. Uncertain operations are fenced rather than blindly repeated.

The monitor refreshes from disk approximately every three seconds after the previous read finishes. It never probes workers, launches model turns, or resends messages. Arrow keys select a worker; Enter toggles its details; Escape closes details before quitting, while q/Ctrl+C always quit the monitor only. Selection follows the worker's session ID across roster reorder. Details show configured responsibility, observations and explicit public worker reports, not inferred task state or approval controls.

- **Worker:** configured name. A roster entry does not prove a process exists.
- **Seen:** age of the status observation, not the last redraw. Evidence older than 60 seconds is marked `(old)`.
- **Status:** last observed working, thinking, idle, closed or unknown. Closed means extension runtime closure, not guaranteed process death. Idle is not a task-completion assertion.
- **Last activity:** a fixed public description of observed activity, which may remain after settlement. No reasoning or tool payload is displayed.
- **Report:** explicitly worker-authored blocked, needs-decision or ready-for-review state, with its own timestamp and public summary in details. It is never coordinator approval or inferred from observed activity.
- **Unknown/partial:** missing, conflicting, future-dated or unreadable evidence is not guessed. Bounded history and dropped observations can make the view incomplete.

Names and descriptions are sanitized for terminal controls and clipped to available display columns. The UI supports narrow/short panes and `NO_COLOR`. Details are read-only: user intent to inspect a worker does not authorize messaging, focusing unrelated panes, stopping agents, or approving work.

## Retired browser dashboard

Version 0.4.1 no longer starts a dashboard HTTP server, ships browser assets, or returns `dashboardUrl` from `intercom_list`. Only Intercom's messaging HTTP endpoints remain.

Old coordinator-only `dashboardPort` fields are accepted for compatibility and removed through a guarded coordinator config update at startup. Listing never advertises the retired port, even if migration failed; a migration warning does not disable messaging. Reload an older running coordinator to close its existing dashboard listener and load the new implementation.

## Privacy and event contract

Logs live under `<coordinator-root>/.pi-intercom/logs/`. They are metadata-only. Message bodies, tool arguments/results, reasoning/text deltas, credentials, raw errors/stacks and responsibility text are not copied into activity logs. The monitor separately reads configured responsibility for details; do not put secrets in configuration. Names, session IDs, timings, endpoints and communication patterns can still be sensitive. Do not commit or publish logs.

Shared `config.json` remains the source-controlled agent configuration; logging and monitor pane ownership do not move agent IDs/ports into a separate runtime registry.

Version 1 fields:

| Field | Meaning |
|---|---|
| `version` | `1` |
| `timestamp` | UTC ISO observation time, not a global ordering guarantee |
| `sessionId` | Pi session identity |
| `writerId` | Ephemeral log-writer UUID, not agent identity |
| `event` | Allowlisted event type |
| `peerSessionId`, `peerName` | Optional peer metadata |
| `correlationId` | One transport attempt, not a task/completion token |
| `kind`, `operation`, `role`, `outcome` | Allowlisted metadata values |
| `busy`, `port` | Observed boolean / port |
| `phase`, `detail` | Fixed public activity enums |
| `errorCode` | Fixed safe error label |

Event types: `runtime.starting`, `runtime.ready`, `runtime.closed`, `runtime.failed`, `config.changed`, `config.reloaded`, `transport.send`, `transport.receipt`, `transport.failed`, `transport.received`, `transport.rejected`, `registration.received`, `status.received`, `launch.result`, `host.submission`, `host.activity`, `host.ui_prompt`.

Activity phases are `working`, `thinking`, `responding`, `tool`, `idle`. Details are `processing`, `thinking`, `responding`, `reading_files`, `editing_files`, `running_command`, `using_tool`, `multiple_tools`, `settled`. Only event discriminants and built-in tool categories are inspected. Repeated streaming phases are deduplicated, and concurrent tools take precedence over streaming hints. Thinking events are provider-dependent; missing events do not establish absence of reasoning.

## Read-only JSON status

`intercom_worker_status` reads this same bounded snapshot, using the same `workerObservation` projection as the monitor. It returns configured workers only, optionally selected by name, with last-observed status/activity, timestamp, age, stale/unknown/conflicting evidence, and independent public reports. Missing or future evidence does not imply health. Clear tombstones appear as null reports.

Pages default to 10 entries (limit 1–20), capped at 40 KiB before the final pagination field, below Pi's tool truncation limits. Follow `nextOffset`; each page is a new local snapshot, not a transaction spanning changing rosters. Snapshot truncation/errors are retained. No model calls, status requests, worker messages, Telegram dependencies or hidden reasoning are involved. Any presentation layer can consume the JSON.

## Explicit public reports

`intercom_report_work` sends a dedicated `report` envelope from a configured, responsibility-loaded worker to the coordinator. Sender identity comes from the envelope/config, not a payload-supplied session ID. The coordinator rechecks permission before saving; writes are serialized with a bounded 64-report in-flight/queued limit and lifecycle guards. One atomic per-worker report file lives under `.pi-intercom/reports/`, named by a SHA-256 hash of the Pi session ID. Files use owner-only permissions where the platform supports them. A clear report is an empty tombstone.

These files are **not metadata-only**: they intentionally contain worker-authored public summaries of at most 2000 characters. Notifications can also place summaries into Pi conversation history. No report body is copied into observation events. Do not put secrets or private reasoning into reports. This is current report state, not an assignment history or durable delivery journal; there is no automatic report retry, acceptance, approval or task completion.

Readers consider only configured workers, at most 256 IDs and 8 KiB per file. Unsafe, invalid, oversized or unreadable files are skipped. Such absence is not proof no blocker exists. Reports can remain after process closure; display report age independently. Retired workers' files are not automatically pruned. Atomic replacement and path checks do not guarantee crash durability or defend against hostile concurrent filesystem manipulation.

## What observations do not establish

- HTTP acceptance is not guaranteed Pi input acceptance, injection, or task completion.
- `host.submission` records a synchronous host call. Pi 0.84.4's void `sendUserMessage` can report manual-compaction rejection asynchronously after receipt; logging does not repair or reliably observe that rejection.
- `agent_settled` supplies the idle boundary, not `agent_end`. Activity observations are not availability guarantees or assignment states.
- `status.received` describes the reporting peer, not the event writer's own activity. It is not used as the writer's status.
- Launch submission does not establish readiness. A correlation ID is not deduplication or a reply promise.
- Stop/close remain disabled. Monitoring adds no cancellation, recovery, retries, commit or rollback.

## Storage bounds and failure behavior

Writers append JSONL to `writer-<UUID>.jsonl`, rotating through `.jsonl.1` and `.jsonl.2`.

| Bound | Policy |
|---|---|
| File size | 1 MiB each, up to three data files per writer |
| Record size | At most 4 KiB |
| Queue | At most 256 queued entries plus one in-flight entry; excess dropped |
| Closed-group retention | Seven days; earlier pruning can target 32 MiB aggregate |
| Cleanup scan | At most 4096 entries per maintenance pass |
| Maintenance | Coordinator startup and every 60 seconds |

A graceful close renames the active file to `.jsonl.closed`, marking the group eligible for pruning. Only closed groups are pruned; active/crash-orphan groups remain untouched. Thus 32 MiB is a best-effort target, not a hard disk cap. Filesystem failures can leave files behind.

Logging never determines communication success. Size/sanitization/queue limits can drop observations; append/rotation failure disables a writer and drops its queue without retrying. Ordinary communication does not await logging I/O. Teardown invalidates the runtime and closes messaging before waiting at most 250 ms for logging shutdown. This is not a guaranteed flush; in-flight filesystem work cannot be cancelled.

The writer rejects pre-existing symlinks at `.pi-intercom` and `logs`; this is best effort, not protection against hostile concurrent filesystem manipulation. Logs are not fsynced as a durable delivery journal.

## Bounded local snapshot reader

`src/snapshot.ts` exposes `readObservationSnapshot` without starting a server:

```text
{ version: 1, generatedAt, staleAfterMs: 60000,
  config: { multiplexer, agents: [selected validated fields] } | null,
  events: [sanitized events, oldest first], reports: [public worker reports], truncated, errors }
```

Limits: config at most 1 MiB / 256 agents; scan at most 512 log entries; select up to 32 newest matching files among those scanned; tail at most 128 KiB per file / 2 MiB total; retain at most 500 latest events. Bounded directory scans do not necessarily find globally newest files. Reads can overlap rotation and are not a transactional global snapshot.

Malformed/partial/unsupported records are ignored. Safe errors include `config_unavailable`, `logs_unavailable`, and `log_read_failed`; raw paths/errors are not displayed. Linked/redirected config/log path components are rejected. This is not a security boundary against hostile local processes; the project and local processes remain trusted.

## Validation scope

Tests cover bounded filesystem reading, sanitization, metadata migration, lifecycle fences, rendering, selection and refresh behavior. They do not by themselves establish live Pi queue acceptance, resumed-agent startup, process cancellation, or every terminal client's visual behavior. Live monitor tests are reported separately; no status display proves unobserved work complete.
