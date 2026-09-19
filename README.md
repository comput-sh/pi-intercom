# PiIntercom (V1 supported core)

One Windows interactive Pi extension for coordinator and workers. **Intercom communicates; Pi orchestrates.** No automatic assignment, retry, removal, replacement, launcher fallback, commit, or rollback.

**`intercom_stop_worker` and `intercom_close_worker` are disabled.** They throw an unsupported-host error before sending control or calling cancellation/shutdown. Incoming stop/close controls also fail. Pi 0.84.4 leaves retry continuation alive after extension abort. See [blocker](references/implementation-blocker.md). Newer versions are not automatically assumed safe; a verified supported lifecycle API and tests are required before enabling these capabilities.

## Use

Requires Windows, Node 22+, interactive Pi with project trust, and this package's peer dependencies supplied by Pi (`@earendil-works/pi-coding-agent`, `typebox`). Launch the coordinator explicitly from the intended root:

```powershell
cd D:\Source\YourProject
pi -e D:\Source\PiIntercom\src\index.ts
```

Alternatively install from npm:

```powershell
pi install npm:@comput/pi-intercom
```

Then start a new Pi session or run `/reload`. Nothing here changes global/project Pi settings automatically. Do not load both the source and built output as separate extensions.

Without shared config, the current working directory becomes the coordinator root. Startup creates `.pi-intercom/config.json`, opens a loopback listener, synchronizes the name `Coordinator`, and waits for user input (no model turn). Existing config is found by walking upward. Invalid/unreadable config is an error and is not overwritten. Unknown session IDs, including forks, are workers, never replacement coordinators.

Default launcher `herdr` requires the coordinator to be inside Herdr (`HERDR_ENV=1` and workspace context), with `herdr` on PATH. Each worker gets **one tab, one pane, no split, no focus change**. The `none` launcher requires `pi.cmd` and Windows PowerShell on PATH and opens a separate visible PowerShell terminal. Missing launcher is an error, not fallback. These launchers have mocked tests but have **not been exercised with live workers**.

## Explicit workflow

1. Coordinator calls `intercom_create_worker({projectDirectory:"."})`. No worker identity, responsibility, callback address or special config path is passed.
2. Anonymous worker opens its own endpoint and sends its session ID, actual port and root-relative project directory to coordinator Pi. Registration starts a normal coordinator turn when idle or queues steering when busy. It creates **no config entry or hidden pending-registration map**.
3. Coordinator decides and calls `intercom_configure_worker` with **all five explicit fields**: `sessionId`, `port`, `projectDirectory`, `name`, `description`. This only writes config.
4. Coordinator separately calls `intercom_reload_worker({to:"Builder"})`. Worker rereads responsibility and synchronizes Pi/Herdr tab names. **This is not Pi `/reload`, a restart, cancellation, or work assignment.** No model turn starts.
5. Coordinator sends explicit work using `intercom_send({to:"Builder",message:"..."})`. Workers can communicate directly with configured peers. Findings do not authorize unrelated implementation. Progress questions ask for reporting and continuation, not cancellation.
6. Workers report as instructed and wait, without autonomous exit. Coordinator unavailability does not close the worker or cancel its assignment.

Existing workers restore responsibility by session ID, bind their saved port or an OS-selected fallback, and report their actual port. Coordinator updates existing ports as bookkeeping. Status from removed/unknown sessions notifies Pi but creates no entry. Resume uses the configured project directory and full session ID, with a saved-session lookup first; a never-used Pi session might not yet exist on disk. Failure leaves config unchanged, without fabricated history or forced model turns.

## Tools and permissions

Every tool rereads current config and checks the live Pi session ID. Names are case-insensitive for lookup/uniqueness; display capitalization is preserved. `Coordinator` is reserved.

| Tool | Permission / effect |
|---|---|
| `intercom_create_worker` | Coordinator; launch anonymous worker, optional directory defaults to root |
| `intercom_configure_worker` | Coordinator; explicit five fields above, writes only |
| `intercom_reload_worker` | Coordinator; named worker's passive config/name reload |
| `intercom_send` | Configured, responsibility-loaded sessions; named asynchronous message |
| `intercom_list` | Configured sessions; saved state only, never live health |
| `intercom_request_status` | Coordinator; ask named worker extension for an independent report |
| `intercom_report_status` | Workers including anonymous; shared report function, never registration |
| `intercom_stop_worker`, `intercom_close_worker` | Coordinator role checked, then **unsupported-host error**, no side effects |
| `intercom_resume_worker` | Coordinator; named saved session, configured launcher/directory |
| `intercom_remove_worker` | Coordinator; config entry only, no shutdown/session deletion |
| `intercom_set_multiplexer` | Coordinator; `herdr` or `none`, future launches only |

**Removal precondition:** explicitly close a running worker before removing its entry. Since remote close is disabled, arrange explicit user closure in its terminal first. Intercom does not infer liveness from saved IDs/ports and cannot certify closure. No hidden probing or force-kill is performed.

Anonymous `send`/`list` and all coordinator operations fail explicitly. Anonymous registration and status remain available. A dedicated repeat-registration operation and broader anonymous permissions remain **unresolved contract TODOs**, not silently added tools. If initial registration fails, the worker remains reachable and reports the error locally. Explicit user Pi `/reload` restarts this extension and repeats startup registration; status is not a substitute and there is no automatic retry.

## Config and wire contracts

Shared, source-controlled file: `<root>/.pi-intercom/config.json`. Do not ignore it or split IDs/ports into runtime config. Example **schema only** (not automatically installed placeholder data):

```json
{
  "version": 1,
  "multiplexer": "herdr",
  "agents": [{
    "sessionId": "actual-pi-session-id",
    "name": "Coordinator",
    "coordinator": true,
    "description": "Coordinate workers, delegate work, and manage shared configuration.",
    "port": 49152,
    "projectDirectory": "."
  }]
}
```

Workers have `coordinator:false` and an existing project directory equal to root or below it. Writes canonicalize directories and check real paths (including symlink escapes). Only coordinator extension operations write config; ordinary Pi file/shell tools are not restricted.

Initial creation writes/fsyncs a complete temporary file then atomically publishes via a no-replace hard link. Contenders see only complete config; exactly one wins. Unsupported hard-link filesystems fail explicitly, without unsafe fallback. Interrupted staging files can remain as ignored `.tmp` files but are never mistaken for config. Updates are serialized, join Pi's file-mutation queue, validate, fsync a temporary file and atomically rename. Duplicate activation of the same coordinator session in multiple processes and external editors racing writes remain outside V1's guarantees (session locks deferred).

HTTP binds **127.0.0.1 only**, `POST /intercom`, UTF-8 JSON, at most 64 KiB. Envelope:

```json
{"version":1,"kind":"message","from":"sender-session-id","to":"expected-recipient-session-id","payload":{"message":"explicit message"}}
```

Kinds: `message`, `registration` (`port`, `projectDirectory`), `status` (`port`, `busy`), `request_status`, `reload`, `stop`, `close` (empty control payload). Sender session identity is the envelope `from`; registration/status agent notifications include an explicit `sessionId` field. Agent messages require configured sender and recipient; controls require the current coordinator's sender ID and a worker recipient. Registration/unknown status are intentional exceptions to configured-sender checks, accepted only by coordinator. All receivers verify expected recipient ID, protecting against stale ports reaching another session. Local processes are trusted: this is role validation, **not authentication**. No remote networking/proxies/redirects or credentials.

`202 {"accepted":true}` means extension receipt/acceptance, never model completion. Invalid/unsupported requests return an error; excessive bodies return 413. Request-status sends its report separately after accepting control. Delivery is normal when idle and steering when busy, sampled at arrival. It does not hard-interrupt an executing tool. Each send resolves the recipient again from config; 5-second receipt deadline, **no retries**. Timeout means unknown outcome, not proof of nondelivery. No durable inbox, deduplication or replay log in V1.

Tool text output is bounded to 50 KiB/2000 lines. Full list data remains in the shared config file. Name sync errors are surfaced; startup retains the useful endpoint, and explicit reload reports failure (Pi name/responsibility may already have changed before a Herdr tab rename fails).

## Development and validation

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run check:package
# Optional installed-host compatibility probe (confirms the known defect):
PI_INTERCOM_PI_ROOT='C:/path/to/pi-coding-agent' npm run test:host
```

Production source runs through Pi's TypeScript loader; `npm run build` generates `dist` for tests. Pi core/typebox are peer dependencies, not bundled. This implementation run installed only cached development dependencies offline with `--legacy-peer-deps`, then used local ignored junctions to installed Pi/typebox for validation. No installed dependency, global setting or unrelated project was changed.

Tests use temporary directories, local test-only HTTP servers, and mocked Pi hosts/launch executors. They never start agents, tabs, terminals, contact models, services or bridges, or access credentials.

### Not live-tested / remaining limitations

- Actual Pi extension loading, idle/steering queue delivery, busy snapshots, session-name persistence, trust UI and session replacement/reload lifecycle with live Pi hosts.
- Herdr tab creation, agent readiness, JSON response shapes, current-pane association and tab rename with live workers. Launcher CLI syntax was checked against installed help only. Herdr's temporary launcher alias is not Intercom/Pi identity and is not saved in config.
- Windows visible terminal/Pi process startup. Success only proves terminal creation, **not Pi readiness**; startup failures remain visible in that terminal. No live readiness handshake was added.
- Actual persisted-session lookup and resumed worker startup; never-used session failure.
- Cross-process/network-drive atomicity and Windows ACL/sharing failures (same-process temp-filesystem races are tested).
- Stop/close remain disabled on all hosts until a verified cancellation API covers retries, compaction continuations and queues. No workaround or weakened guarantee.
- Explicit repeat-registration tool and broad anonymous permissions require a contract decision. Duplicate-session locks, takeover, durable logging and non-Windows support are deferred.
