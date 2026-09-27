# Improvement topics

Pi Intercom's direction is a **coordinator-led workspace for Pi**: delegate into separate worker contexts, evaluate their reports, and keep the main conversation focused—with the team visible alongside it.

This is a proposed discussion backlog, not an implementation plan, release commitment, or description of features already shipped. Decisions should reinforce that workflow rather than duplicate every feature of a general messaging platform. The coordinator remains responsible for orchestration; transport and UI must not silently assign, retry, approve, or declare work complete.

## First priorities

### 1. Message identity and delivery evidence

Current transport receipt does not prove Pi accepted a message or that a worker acted on it. Introduce explicit message IDs and distinguish receipt, held delivery, injection/submission, reply, and failure. Investigate host support for truthful acknowledgments and holding messages during compaction. Deduplicate retries without silently resending. A timeout is an uncertain outcome, not cancellation.

Decide whether pending messages survive extension reload or process restart, with explicit storage bounds, expiry and privacy rules. Do not present an in-memory queue as durable delivery.

### 2. Assignments, reports and pending decisions

Link follow-up messages and reports to explicit assignment IDs. Keep configured responsibility, current assignment, host activity, and task state distinct. Add concise structured reports: findings, changed files, validation, blockers, and decisions needed. A worker's completion claim should remain pending coordinator evaluation, not automatically become accepted work.

Consider threaded reply and a pending-decisions view. If blocking ask/reply is added, use it selectively for workers; avoid blocking the main coordinator on a long wait. Define timeout, cancellation and simultaneous-request behavior first.

### 3. Presence versus activity

Separate last contact from the time of the last activity change. A bounded extension-level heartbeat could establish fresh contact without model turns, but it must not make an old thinking/tool observation look newly confirmed. Show unavailable, stale and unknown honestly. Think through shutdown, crash, reload and missing-log cases.

## Workflow improvements

### 4. Context hygiene and report quality

Provide reusable task briefs with scope, constraints, file ownership and expected output. Prefer concise reports and on-demand detail over copying full worker transcripts into the coordinator. Consider report-size budgets and summaries for long-running work. Keep original findings retrievable; never silently discard material blockers or claim that context size or responsiveness is guaranteed.

### 5. Human-first coordination

Consider prioritizing human input over routine peer chatter. Batch low-priority progress while surfacing explicit decision requests. Define fairness so worker messages do not starve. Keep delivery policy visible and never equate background activity with permission to interrupt or expand scope.

### 6. Shared-code safety

Separate model contexts do not isolate files. Establish explicit file ownership for concurrent assignments, avoid concurrent edits to the same files, and consider opt-in worktrees for implementation workers. Review and integration remain deliberate steps. Do not automatically merge, commit, or roll back worker changes.

### 7. Worker and monitor lifecycle

Expand live tests for worker registration, resume, session replacement, duplicate sessions, coordinator restart and monitor-pane recovery. Distinguish a monitor pane existing from its process running; only restart into a positively identified safe target. Resolve known cancellation limitations before enabling worker stop/close—message cancellation is not process cancellation.

## Product and maintenance

### 8. Finish the terminal-monitor transition

**Source progress:** browser server/assets removed, snapshot reading extracted, legacy dashboard metadata retired on coordinator startup, and listing no longer advertises dashboard URLs. Package validation and a release are still required before npm users receive these changes.

Original scope: decide whether to remove the browser dashboard entirely or make it explicitly optional. Consolidate shared observation code, migrate legacy dashboard fields deliberately, and remove obsolete docs/tests only when their functionality is retired. Keep installation, source builds and published-package behavior consistent. The terminal monitor replaces the browser dashboard in 0.4.0; it was not available in npm 0.3.0.

### 9. Make the monitor useful for decisions

**0.4.0 progress:** keyboard selection, roster scrolling and worker details are implemented. `intercom_report_work` now stores one explicitly worker-authored blocked/needs-decision/ready-for-review report (or clear tombstone), notifies the coordinator, and displays it separately from host activity. Reports do not imply acceptance or completion. Read-only `intercom_worker_status` exposes shared observation/report data as bounded JSON without chat coupling. Assignment-threaded reports, coordinator decision history and verified worker-pane navigation remain potential follow-ups.

Once assignment and report data exist, show pending decisions, blockers and review-needed work—not just host activity. Consider worker selection, keyboard navigation, and opening the correct worker pane. Preserve concise default views, terminal accessibility, reliable identity targeting, and explicit user intent for any controls.

### 10. Integration and transport choices

Evaluate whether broker-based discovery or an existing messaging backend would reduce maintenance without weakening project boundaries or coordinator ownership. CLI access, attachments, subagent bridges and cross-machine work are possible later directions, not prerequisites for a good local coordinator workflow. Assess trust, privacy and recovery costs before expanding scope.

## Suggested sequence

1. Agree on assignment/message identities and truthful state meanings.
2. Improve delivery evidence and add concise reports with pending decisions.
3. Separate presence from activity and surface those facts in the monitor.
4. Validate lifecycle and shared-file workflows, finish the dashboard transition, then release.

Context hygiene, human-priority delivery, and optional integrations can build on those foundations. No proposed feature should bypass project trust, hide uncertainty, expose private reasoning, or turn a status display into an implicit orchestrator.
