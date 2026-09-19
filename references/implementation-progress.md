# Implementation progress — supported core delivered

> **Historical initial-implementation snapshot.** Counts, environment details, and statements about no live workers, publishing or commits below describe that original run only. The snapshot is preserved unchanged below; [README](../README.md) records subsequent releases, observed 0.1.2 live behavior and current limitations. Do not use this snapshot as today's validation inventory.

## Implemented
- Single TypeScript Pi extension: coordinator/anonymous/existing worker startup, explicit registration handoff, passive configure/reload separation, role/session/recipient gates, normal/steering delivery, independent status reports and current-port bookkeeping.
- Upward config discovery, atomic no-replace initialization, serialized/atomic validated coordinator writes, case-insensitive names and canonical descendant-directory checks.
- Loopback-only bounded HTTP receipts with 5-second deadline and no retries.
- All 12 agreed tools registered. Stop/close fail closed on tool and wire paths before transport cancellation or host abort/shutdown. No host workaround.
- Herdr one-tab/one-pane and Windows visible-terminal launch adapters; saved-session preflight and name synchronization. No fallback, replacement or hidden orchestration.
- README covers schemas, permissions, startup, failure/receipt semantics, disabled capabilities and outstanding contract gaps.

## Final validation
- `npm run typecheck`: PASS.
- `npm test` (includes TypeScript build): 19 passed, 0 failed.
- Existing installed Pi cancellation probe: 3 passed, 0 failed; confirms the undesired retry-continuation behavior, not cancellation compliance.
- `npm run check:package`: PASS; 9 source/documentation/package files, no settings/runtime artifacts in package.
- Installed jiti smoke import of `src/index.ts` + mocked factory: PASS; 12 tools and 3 lifecycle hooks registered without starting a session/listener.
- Test-only loopback HTTP and temporary filesystem checks were real; Pi hosts, transport routing integration and launch commands were mocked.

## Remaining blockers / not live-tested
- Stop/close disabled until supported cancellation covers active work, retry backoff, compaction continuations and pending queues. No version-only enable switch.
- Dedicated repeat-registration operation and broader anonymous permissions remain explicit TODO/error. Explicit user Pi `/reload` can repeat startup; status never substitutes for registration.
- NOT live-tested: Pi interactive loading/delivery/queues/busy/lifecycle/trust/name persistence; Herdr creation/readiness/JSON shapes/tab association/rename; visible-terminal Pi startup/readiness; actual persisted-session resume; cross-process/network-filesystem atomicity and ACL/sharing failures. Launcher help syntax only was inspected. Terminal launch is not registration or Pi-readiness proof.
- Duplicate session activation locks, coordinator takeover, durable logging and non-Windows support remain deferred.

## Changed paths
- New: `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`.
- New: `src/config.ts`, `src/transport.ts`, `src/runtime.ts`, `src/launcher.ts`, `src/index.ts`.
- New: `tests/core.test.mjs`, `tests/integration.test.mjs`, `tests/launcher.test.mjs`, `tests/extension.test.mjs`.
- New: this `references/implementation-progress.md`.
- Updated: `references/implementation-blocker.md` with a current-status banner; original probe/evidence preserved.
- Generated/ignored: `dist/`, `node_modules/` (offline development dependencies and local peer junctions).

Existing `.pi/settings.json`, local connection settings, authoritative spec/design files and cancellation probe preserved. No shared runtime config was created in this project, no live Pi workers/tabs/terminals/models/services/bridges were used, no credentials accessed, no installed Pi/other-project/global-setting modifications, no subagents spawned, no messages sent, no commits.
