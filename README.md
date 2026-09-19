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

Then start a new Pi session or run Pi `/reload`. `pi install` records the package in user settings by default; add `-l` for project settings. The Intercom extension itself does not change Pi settings. Load only one copy: do not enable the installed package alongside an explicit source checkout, or load both source and built output.

### Updating the loaded copy

- **npm installation:** update the installed package, not this checkout: `pi update npm:@comput/pi-intercom`. A pinned version must be explicitly changed (for example, `pi install npm:@comput/pi-intercom@0.1.2`, using the same settings scope as the original installation). `pi list` shows configured package sources; inspect that installation's `package.json` to confirm its version.
- **Source loading (`pi -e .../src/index.ts`):** update that checkout. `npm run build` produces test output; it does not update a separate npm installation.
- After obtaining the intended code, start a new session or use Pi `/reload` in each affected running host. **`intercom_reload_worker` only reads shared configuration; it cannot load extension-code fixes.** Workers launched by a coordinator receive the coordinator extension's actual file path. Updating a different copy does not change that path, and existing workers do not automatically reload.

The 0.1.2 update/reload and subsequent worker creation were observed live; comprehensive reload/session-replacement lifecycle coverage remains pending.

### Startup and launchers

Without shared config, the current working directory becomes the coordinator root. Startup creates `.pi-intercom/config.json`, opens a loopback listener, synchronizes the name `Coordinator`, and waits for user input (no model turn). Existing config is found by walking upward. Invalid/unreadable config is an error and is not overwritten. Unknown session IDs, including forks, are workers, never replacement coordinators.

Default launcher `herdr` requires the coordinator to be inside Herdr (`HERDR_ENV=1` and workspace context), with `herdr` on PATH and `powershell.exe` plus `pi.ps1` available in the worker pane. Each worker gets **one tab, one pane, no split, no focus change**. The `none` launcher requires `pi.cmd` and Windows PowerShell on PATH and opens a separate visible PowerShell terminal. Missing launcher is an error, not fallback. Launch acknowledgment means command submission/terminal creation, not Pi readiness. A failed launch can leave a tab or process behind; no automatic cleanup occurs. See the scoped live evidence below.

## Explicit workflow

1. Coordinator calls `intercom_create_worker({projectDirectory:"."})`. No worker identity, responsibility, callback address or special config path is passed.
2. Anonymous worker opens its own endpoint and sends its session ID, actual port and root-relative project directory to coordinator Pi. Registration starts a normal coordinator turn when idle or queues steering when busy. It creates **no config entry or hidden pending-registration map**.
3. Coordinator decides and calls `intercom_configure_worker` with **all five explicit fields**: `sessionId`, `port`, `projectDirectory`, `name`, `description`. This only writes config.
4. Coordinator separately calls `intercom_reload_worker({to:"Builder"})`. Worker rereads responsibility and synchronizes Pi/Herdr tab names. **This is not Pi `/reload`, a restart, cancellation, or work assignment.** No model turn starts.
5. Coordinator sends explicit work using `intercom_send({to:"Builder",message:"..."})`. Workers can communicate directly with configured peers. Findings do not authorize unrelated implementation. Progress questions ask for reporting and continuation, not cancellation.
6. Workers report as instructed and wait, without autonomous exit. Coordinator unavailability does not close the worker or cancel its assignment.

Existing workers restore responsibility by session ID, bind their saved port or, if it is already in use, an OS-selected fallback, and report their actual port. Coordinator updates existing ports as bookkeeping. Status from removed/unknown sessions notifies Pi but creates no entry. Resume uses the configured project directory and full session ID, with a saved-session lookup first; a never-used Pi session might not yet exist on disk. Failure leaves config unchanged, without fabricated history or forced model turns.

## Tools and permissions

Every tool rereads current config and checks the live Pi session ID. Names are case-insensitive for lookup/uniqueness; display capitalization is preserved. `Coordinator` is reserved.

| Tool | Arguments | Permission / effect |
|---|---|---|
| `intercom_create_worker` | `projectDirectory?` (default `.`) | Coordinator; launch anonymous worker |
| `intercom_configure_worker` | `sessionId`, `port`, `projectDirectory`, `name`, `description` | Coordinator; all five explicit fields, writes only |
| `intercom_reload_worker` | `to` (worker name) | Coordinator; passive config/name reload |
| `intercom_send` | `to` (name), `message` | Configured, responsibility-loaded sessions; asynchronous message |
| `intercom_list` | None | Configured sessions; saved state only, never live health |
| `intercom_request_status` | `to` (worker name) | Coordinator; independent extension report |
| `intercom_report_status` | None | Workers including anonymous; shared report function, never registration |
| `intercom_stop_worker`, `intercom_close_worker` | `to` (worker name) | Coordinator role checked, then **unsupported-host error**, no side effects |
| `intercom_resume_worker` | `to` (worker name) | Coordinator; saved session, configured launcher/directory |
| `intercom_remove_worker` | `to` (worker name) | Coordinator; config entry only, no shutdown/session deletion |
| `intercom_set_multiplexer` | `multiplexer`: `herdr` or `none` | Coordinator; future launches only |

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

`202 {"accepted":true}` means Intercom extension receipt/dispatch, **not guaranteed Pi input acceptance, queueing, or model completion**. In Pi 0.84.4, `sendUserMessage` can reject during manual compaction after Intercom has acknowledged receipt: its void extension API reports the asynchronous rejection only as a local host error. Intercom has no delivery queue or retry to repair this gap; inspect the recipient's local error and arrange an explicit resend after compaction if needed. Replacing it with `sendMessage` is not a safe workaround because that path can start a concurrent run. Invalid/unsupported requests return an error; excessive bodies return 413. Request-status sends its report separately after accepting control. Delivery is normal when idle and steering when busy, sampled at arrival. It does not hard-interrupt an executing tool. Each send resolves the recipient again from config; 5-second receipt deadline, **no retries**. Timeout means unknown outcome, not proof of nondelivery. No durable inbox, deduplication or replay log in V1.

Tool text output is bounded to 50 KiB/2000 lines. Full list data remains in the shared config file. Name sync errors are surfaced; startup retains the useful endpoint, and explicit reload reports failure (Pi name/responsibility may already have changed before a Herdr tab rename fails).

## Development and validation

Run these commands from a source checkout; tests and workflows are not shipped in the npm package. The [original implementation validation snapshot](https://github.com/mbundgaard/PiIntercom/blob/main/references/implementation-progress.md) is historical, not the current live-test inventory.

```sh
npm ci
npm run typecheck
npm test
npm run check:package
# Optional installed-host compatibility probe (confirms the known defect):
PI_INTERCOM_PI_ROOT='C:/path/to/pi-coding-agent' npm run test:host
```

Production source runs through Pi's TypeScript loader; `npm run build` generates `dist` for tests. Pi core/typebox are peer dependencies, not bundled; pinned development copies are included in the lockfile for reproducible CI without local junctions.

## Publishing

[`.github/workflows/publish.yml`](https://github.com/mbundgaard/PiIntercom/blob/main/.github/workflows/publish.yml) publishes through npm Trusted Publishing (GitHub OIDC), without an npm token secret. Configure the npm trusted publisher as owner `mbundgaard`, repository `PiIntercom`, workflow `publish.yml`, with no environment.

The workflow validates on Windows, then publishes with provenance from a GitHub-hosted Ubuntu runner. It runs when a GitHub release is published or when manually dispatched. Release tags must be `v<package.json version>`.

Published versions are immutable. For a new release, bump package and lockfile versions, commit/push, then publish a matching GitHub release. Manual dispatch publishes the selected ref and is **not a dry run**; the release-tag check only applies when a release tag is present. Do not dispatch publishing for an already published version. CI validates pushes to `main` and pull requests separately without publishing.

### Release evidence

- [v0.1.1](https://github.com/mbundgaard/PiIntercom/releases/tag/v0.1.1): successful npm OIDC [run 35466923379](https://github.com/mbundgaard/PiIntercom/actions/runs/35466923379).
- [v0.1.2](https://github.com/mbundgaard/PiIntercom/releases/tag/v0.1.2): successful npm OIDC [run 35467586052](https://github.com/mbundgaard/PiIntercom/actions/runs/35467586052). Fixes Windows Herdr launching by using `herdr pane run` on the returned pane ID with encoded PowerShell invoking `pi.ps1`, instead of the failing `Start-Process pi` wrapper. No Herdr agent alias is needed.

### 0.1.3 changes and verification

Version 0.1.3 includes these fixes (not present in 0.1.2):

- Lifecycle generation/session checks reject stale queued or in-flight operations before submitting new launches, sends, deliveries or config publication. This includes delayed listener startup, anonymous registration and deferred status reporting. An OS link/rename or external action already submitted before invalidation is **not cancelled or rolled back**; there is no guarantee that in-flight external actions are drained.
- Failed temporary-file write, sync or close attempts best-effort close/unlink cleanup while preserving the primary error. Filesystem cleanup failures can still leave temporary files.
- Resume preflight now follows the child session-storage context: `PI_CODING_AGENT_SESSION_DIR`, then target-project/global `sessionDir` settings, then Pi's default. Relative storage paths resolve against the target working directory. Launchers do not propagate the coordinator's CLI `--session-dir`; no machine-specific session path is stored in shared config. A static persisted-session fixture and mocked launcher validate lookup, not live resumed-worker startup.

Coordinator validation of this source snapshot: `npm run typecheck` PASS; `npm test` **36/36**, no failures; `npm run check:package` PASS; `git diff --check` PASS (line-ending warnings only). Quality independently confirmed typecheck and all 36 tests, with no remaining actionable regression identified in these fixes. Tests include actual extension-adapter event handling against a mocked Pi API/context and runtime-to-runtime loopback HTTP; they do not establish real Pi queue or compaction behavior.

Tests use temporary directories, local test-only HTTP servers, static session fixtures and mocked Pi hosts/launch executors. They never start agents, tabs, terminals, contact models, services or bridges, or access credentials.

### Observed live behavior

The release/session evidence reported during the 0.1.2 validation establishes these specific observations, not blanket lifecycle compliance:

- Encoded PowerShell invoking `pi.ps1` recovered an existing failed Herdr tab; Pi started and the worker registered.
- After package update and Pi reload, coordinator `intercom_create_worker` launched three workers; each registered, then was explicitly configured and separately reloaded. Integration's configured name was applied through configure/reload.
- An asynchronous Core → Coordinator message was relayed with `telegram_send` and receipt was confirmed by the owner. Telegram is a separate integration, not an Intercom transport or automatic forwarding feature.

### Remaining limitations / not comprehensively live-tested

- Idle/steering queue edge cases, busy snapshots, session-name persistence across restarts, trust UI and session replacement/reload lifecycle. The specific manual-compaction rejection gap described above remains unresolved; successful ordinary messaging does not verify that case.
- The observations above do not establish all Herdr failure paths, tab-association edge cases or readiness guarantees.
- Windows visible terminal/Pi process startup. Success only proves terminal creation, **not Pi readiness**; startup failures remain visible in that terminal. No live readiness handshake was added.
- Actual persisted-session lookup and resumed worker startup; never-used session failure.
- Cross-process/network-drive atomicity and Windows ACL/sharing failures (same-process temp-filesystem races are tested).
- Stop/close remain disabled on all hosts until a verified cancellation API covers retries, compaction continuations and queues. No workaround or weakened guarantee.
- Explicit repeat-registration tool and broad anonymous permissions require a contract decision. Duplicate-session locks, takeover, durable logging and non-Windows support are deferred.
