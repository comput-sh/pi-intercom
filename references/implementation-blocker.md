# V1 cancellation capability blocked: Pi cancellation contract

> **Current status:** The user subsequently approved implementing independent features. The supported core now exists; see the [historical implementation snapshot](https://github.com/comput-sh/pi-intercom/blob/main/references/implementation-progress.md) and [current README](../README.md). Stop/close remain disabled, failing before cancellation/shutdown; README also records the separate manual-compaction input-acceptance gap. The historical feasibility report below is preserved as evidence; its statements that no implementation exists describe the earlier run, not current project status.

## Historical outcome

Implementation was stopped at the API feasibility gate required by the implementation request. **PiIntercom V1 is not implemented.** No package, extension, launcher, transport, or shared configuration has been created. Existing project settings and installed Pi files were not changed.

Installed Pi version inspected: **0.84.4**.

## Concrete blocker

The V1 stop/close contract requires cancelling current work without automatically restarting queued or pending work. In the installed interactive host, extension `ctx.abort()` clears steering/follow-up/compaction message queues, but calls only the low-level agent's `abort()`. It does **not** cancel the separate session retry timer. During retry backoff there is no active low-level agent run to abort. After backoff, Pi continues the previous assignment with `agent.continue()` even though the extension requested cancellation.

`ctx.shutdown()` does not repair this: interactive shutdown waits for session idle, so the automatic continuation can execute before shutdown. Rejecting new HTTP messages during stop/close also cannot cancel this already pending internal continuation.

This is narrower than saying Pi cannot clear queues: queue clearing **does work**, and the probe verifies it. The missing cancellation coverage is the blocker.

Installed source evidence (paths relative to the installed `pi-coding-agent` package):

- `dist/modes/interactive/interactive-mode.js:1451–1456`: extension `abortHandler` calls `restoreQueuedMessagesToEditor({ abort: true })`.
- Same file, `:3568–3618`: clears queued messages into the editor, then calls `this.agent.abort()`.
- `node_modules/@earendil-works/pi-agent-core/dist/agent.js:202–204`: abort affects only `activeRun?.abortController`.
- `dist/core/agent-session.js:2279–2322`: `_prepareRetry()` sleeps using a separate `_retryAbortController`, then returns `true` unless that controller was cancelled.
- Same file, `:772–795`: post-run loop calls `agent.continue()` following a successful retry wait.
- `dist/modes/interactive/interactive-mode.js:1507–1512`: shutdown is deferred while the session is busy.
- Same file, `:2762–2764` and `:2820–2822`: interactive Escape uses separate session cancellation APIs for compaction and retry. Those APIs are not exposed on `ExtensionContext`.

Compaction cancellation also needs validation with an upstream fix; this run reproduced the retry problem specifically, not every compaction case.

## Decision needed

**Recommended:** require a Pi version with a supported extension cancellation operation that cancels active tools/model work, retry backoff, compaction continuations, and queued work as one lifecycle operation. Have that fixed/verified in Pi separately, then resume this implementation. This task does not authorize changing the installed host or an unrelated Pi source project.

Alternatively, explicitly revise the V1 stop/close guarantees to permit best-effort cancellation and possible continuation. That is a semantic change and has not been implemented or assumed approved.

No private-runtime access, repeated abort polling, synthetic Escape input, settings changes disabling retries/compaction, forced shutdown, or hidden recovery has been introduced as a workaround. Intercom communication must remain independent of launcher choice.

## Validation

Added `tests/pi-cancellation-probe.test.mjs`, a dependency-free compatibility probe. It extracts selected installed methods and executes them with mocks; it does not construct a Pi session, read credentials, contact a model, bind a server, launch a process, or modify Herdr.

Git Bash invocation from a source checkout (the probe is not shipped in the npm package):

```bash
PI_INTERCOM_PI_ROOT='C:/Users/martin/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent' \
  node --test tests/pi-cancellation-probe.test.mjs
```

Actual result: **3 tests passed, 0 failed**:

1. Installed interactive extension abort delegates to the queue-restoration path.
2. That path clears queued work into the editor and aborts an active low-level run.
3. During retry backoff, the same path leaves the retry signal un-aborted and `_prepareRetry()` returns `true`, enabling continuation.

The third passing test confirms the **undesired installed behavior**, not V1 compliance. This is a source-backed mocked compatibility probe, not a live end-to-end test. Source-layout changes intentionally fail the probe rather than silently testing different code.

No typecheck/build/package checks are applicable yet: implementation stopped before creating the package. No live Pi worker, Herdr tab, terminal, service, or messaging bridge was started. Herdr commands were help/discovery only.

## Preserved decisions and remaining scope

The authoritative `v1-specification.md` remains unchanged. In particular, the historical review's pending-registration-map suggestion is superseded: registration must deliver ID/port/directory to the coordinator agent; configure takes those explicit values and only writes configuration; reload stays separate. Never-used-session resume failure is already allowed by the authoritative spec and is not reopened here.

Other implementation gaps (explicit registration-repeat operation and anonymous permissions) remain as listed in the authoritative spec. No additional tool contract or permissions decision was silently made while blocked.

`D:/Source/PiIntercom` had no `.git` directory at inspection; `git status` returned “not a git repository”. No repository was initialized and no commit was made.

## Changed paths

- `tests/pi-cancellation-probe.test.mjs` — new compatibility probe.
- `references/implementation-blocker.md` — this report.
