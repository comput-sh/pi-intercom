import { randomUUID } from 'node:crypto';
import type { Agent, Config } from './config.js';

export interface WorkerPaneIdentity {
  workspaceId: string; paneId: string; terminalId: string; sessionId: string;
  sessionFile: string; pid: number; processStart: string;
}
export interface CloseProvider {
  getIdentity(): Promise<WorkerPaneIdentity>;
  inspect(identity: WorkerPaneIdentity, expectedSessionId: string, assertCurrent: () => void): Promise<void>;
  close(identity: WorkerPaneIdentity, expectedSessionId: string, assertCurrent: () => void, beforeSubmit: () => Promise<void>): Promise<{ paneClosed: boolean; workerExited: boolean }>;
}
export type CloseReason = 'timeout' | 'interrupted' | 'delivery_failed' | 'identity_failed' | 'save_failed' | 'worker_changed' | 'worker_busy' | 'commit_rejected' | 'close_unverified' | 'close_failed';
export type CloseState = 'requested' | 'awaiting_handoff' | 'awaiting_settlement' | 'ready' | 'closing' | 'closed' | 'failed' | 'timed_out' | 'interrupted' | 'uncertain';
export interface Handoff { version: 1; summary: string; updatedAt: string; jobId: string }
export interface CloseJob { jobId: string; state: CloseState; createdAt: string; updatedAt: string; deadlineAt: string; reason?: CloseReason }
export type HandoffKind = 'close_prepare' | 'close_identity' | 'close_request' | 'handoff_report' | 'close_ready' | 'close_commit';
export const HANDOFF_KINDS: readonly string[] = ['close_prepare', 'close_identity', 'close_request', 'handoff_report', 'close_ready', 'close_commit'];
const states: CloseState[] = ['requested', 'awaiting_handoff', 'awaiting_settlement', 'ready', 'closing', 'closed', 'failed', 'timed_out', 'interrupted', 'uncertain'];
const reasons: CloseReason[] = ['timeout', 'interrupted', 'delivery_failed', 'identity_failed', 'save_failed', 'worker_changed', 'worker_busy', 'commit_rejected', 'close_unverified', 'close_failed'];
export const pendingClose = (job?: CloseJob) => !!job && ['requested', 'awaiting_handoff', 'awaiting_settlement', 'ready', 'closing'].includes(job.state);
export const fencedClose = (job?: CloseJob) => pendingClose(job) || job?.state === 'uncertain';
function requireValue(ok: unknown): asserts ok { if (!ok) throw new Error('PiIntercom: invalid handoff protocol/state'); }
const string = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
export function validateIdentity(value: unknown): asserts value is WorkerPaneIdentity {
  const v = value as WorkerPaneIdentity;
  requireValue(v && ['workspaceId', 'paneId', 'terminalId', 'sessionId', 'processStart'].every(k => string(v[k as keyof WorkerPaneIdentity], 256)) && string(v.sessionFile, 4096) && Number.isSafeInteger(v.pid) && v.pid > 0);
}
export function validateHandoff(value: unknown): asserts value is Handoff {
  const v = value as Handoff;
  requireValue(v && v.version === 1 && token(v.jobId) && string(v.summary, 4000) && timestamp(v.updatedAt));
  requireValue(Object.keys(v).every(k => ['version', 'jobId', 'summary', 'updatedAt'].includes(k)));
}
export function validateCloseJob(value: unknown): asserts value is CloseJob {
  const v = value as CloseJob;
  requireValue(v && token(v.jobId) && states.includes(v.state) && timestamp(v.createdAt) && timestamp(v.updatedAt) && timestamp(v.deadlineAt) && (v.reason === undefined || reasons.includes(v.reason)));
  requireValue(Object.keys(v).every(k => ['jobId', 'state', 'createdAt', 'updatedAt', 'deadlineAt', 'reason'].includes(k)));
}
export function validateHandoffPayload(kind: string, p: Record<string, unknown>): void {
  requireValue(token(p.jobId));
  const keys: Record<string, string[]> = {
    close_prepare: ['jobId', 'deadlineAt'], close_identity: ['jobId', 'instanceId', 'identity'],
    close_request: ['jobId', 'instanceId'], handoff_report: ['jobId', 'instanceId', 'summary'],
    close_ready: ['jobId', 'instanceId', 'readyNonce'], close_commit: ['jobId', 'instanceId', 'readyNonce'],
  };
  requireValue(!!keys[kind] && Object.keys(p).every(k => keys[kind].includes(k)));
  if (kind === 'close_prepare') requireValue(timestamp(p.deadlineAt));
  else requireValue(token(p.instanceId));
  if (kind === 'close_identity') validateIdentity(p.identity);
  if (kind === 'handoff_report') requireValue(string(p.summary, 4000));
  if (kind === 'close_ready' || kind === 'close_commit') requireValue(token(p.readyNonce));
}
interface Context {
  state(): Promise<{ id: string; config: Config; me?: Agent }>;
  assertCurrent(): void;
  update(mutate: (config: Config) => void, guard?: () => void): Promise<void>;
  send(sessionId: string, kind: HandoffKind, payload: Record<string, unknown>): Promise<void>;
  deliver(message: string): void;
  busy(): boolean;
  provider?: CloseProvider;
  timeoutMs?: number;
}
interface Pending {
  target: Agent; job: CloseJob; timer: ReturnType<typeof setTimeout>;
  identity?: WorkerPaneIdentity; instanceId?: string; initialized?: Promise<void>; processing: boolean; closing: boolean; ended: boolean;
}
interface WorkerPending {
  jobId: string; coordinatorId: string; deadline: number; requested: boolean;
  saved: boolean; reporting: boolean; invalidated: boolean; epoch: number;
  readyNonce?: string; toolCallId?: string; committed: boolean; timer: ReturnType<typeof setTimeout>;
}
/** Extension-owned asynchronous protocol. No host abort, shutdown, automatic retries or guessed pane targets. */
export class HandoffWorkflow {
  private readonly instanceId = randomUUID();
  private jobs = new Map<string, Pending>();
  private worker?: WorkerPending;
  private epoch = 0;
  private disposed = false;
  private readonly timeout: number;
  constructor(private readonly ctx: Context) {
    this.timeout = Number.isFinite(ctx.timeoutMs) ? Math.max(1, Math.min(120000, ctx.timeoutMs!)) : 120000;
  }
  private valid() { requireValue(!this.disposed); this.ctx.assertCurrent(); }
  private background(work: () => Promise<void>) { setImmediate(() => { if (!this.disposed) void work().catch(() => {}); }); }
  dispose(): void {
    this.disposed = true;
    for (const p of this.jobs.values()) { p.ended = true; clearTimeout(p.timer); }
    this.jobs.clear();
    if (this.worker) clearTimeout(this.worker.timer);
    this.worker = undefined;
  }
  async recover(): Promise<void> {
    const { me, config } = await this.ctx.state();
    if (!me?.coordinator || !config.agents.some(a => pendingClose(a.closeJob))) return;
    await this.ctx.update(c => {
      for (const a of c.agents) if (pendingClose(a.closeJob)) {
        a.closeJob = { ...a.closeJob!, state: a.closeJob!.state === 'closing' ? 'uncertain' : 'interrupted', reason: 'interrupted', updatedAt: new Date().toISOString() };
      }
    });
  }
  private assertJob(p: Pending) {
    this.valid();
    requireValue(!p.ended && this.jobs.get(p.target.sessionId) === p && Date.now() < Date.parse(p.job.deadlineAt));
  }
  private target(c: Config, p: Pending): Agent {
    this.assertJob(p);
    const a = c.agents.find(a => a.sessionId === p.target.sessionId && !a.coordinator);
    requireValue(a && a.closeJob?.jobId === p.job.jobId && pendingClose(a.closeJob) && a.port === p.target.port && a.projectDirectory === p.target.projectDirectory);
    return a;
  }
  private async transition(p: Pending, state: CloseState, reason?: CloseReason): Promise<void> {
    await this.ctx.update(c => {
      const a = this.target(c, p);
      a.closeJob = { ...a.closeJob!, state, updatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
      p.job = { ...a.closeJob };
    }, () => this.assertJob(p));
  }
  private async finish(p: Pending, state: CloseState, reason?: CloseReason): Promise<void> {
    if (p.ended) return;
    p.ended = true; clearTimeout(p.timer);
    // Keep the in-memory fence if persistence fails. Reload recovers durable intent.
    try {
      this.valid();
      await this.ctx.update(c => {
        const a = c.agents.find(a => a.sessionId === p.target.sessionId && !a.coordinator);
        requireValue(a?.closeJob?.jobId === p.job.jobId);
        a.closeJob = { ...a.closeJob, state, updatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
      });
      this.jobs.delete(p.target.sessionId);
    } catch { /* Failure never authorizes pane closure or replay. */ }
  }
  async request(target: Agent): Promise<CloseJob> {
    this.valid(); requireValue(this.ctx.provider);
    const existing = this.jobs.get(target.sessionId);
    if (existing) { await existing.initialized; return { ...existing.job }; }
    requireValue(!fencedClose(target.closeJob) && this.jobs.size < 16);
    const now = Date.now();
    const job: CloseJob = { jobId: randomUUID(), state: 'requested', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), deadlineAt: new Date(now + this.timeout).toISOString() };
    const p: Pending = { target: { ...target }, job, timer: undefined as unknown as ReturnType<typeof setTimeout>, processing: false, closing: false, ended: false };
    // Install the fence synchronously, before the first asynchronous config write.
    this.jobs.set(target.sessionId, p);
    try {
      p.initialized = this.ctx.update(c => {
        const a = c.agents.find(a => a.sessionId === target.sessionId && !a.coordinator);
        requireValue(a && !fencedClose(a.closeJob) && a.port === target.port && a.projectDirectory === target.projectDirectory && c.multiplexer === 'herdr');
        a.closeJob = { ...job };
      }, () => this.assertJob(p));
      await p.initialized;
    } catch (error) { this.jobs.delete(target.sessionId); throw error; }
    p.timer = setTimeout(() => { void this.finish(p, p.closing ? 'uncertain' : 'timed_out', 'timeout'); }, Math.max(0, Date.parse(job.deadlineAt) - Date.now()));
    this.background(async () => {
      try { this.assertJob(p); await this.ctx.send(target.sessionId, 'close_prepare', { jobId: job.jobId, deadlineAt: job.deadlineAt }); }
      catch { await this.finish(p, 'failed', 'delivery_failed'); }
    });
    return { ...job };
  }
  workerStarted(): void {
    this.epoch++;
    const w = this.worker;
    if (w && (w.saved || w.reporting)) { w.invalidated = true; w.readyNonce = undefined; }
  }
  workerSettled(successfulToolCallIds: ReadonlySet<string>): void {
    const w = this.worker;
    if (!w || !w.saved || w.reporting || w.invalidated || w.readyNonce || w.committed || this.ctx.busy() || w.epoch !== this.epoch || !w.toolCallId || !successfulToolCallIds.has(w.toolCallId)) return;
    w.readyNonce = randomUUID();
    this.background(async () => {
      this.assertWorker(w);
      requireValue(!this.ctx.busy() && w.epoch === this.epoch && !w.invalidated);
      await this.ctx.send(w.coordinatorId, 'close_ready', { jobId: w.jobId, instanceId: this.instanceId, readyNonce: w.readyNonce });
    });
  }
  private assertWorker(w: WorkerPending) {
    this.valid(); requireValue(this.worker === w && Date.now() < w.deadline);
  }
  get workerClosing(): boolean { return !!this.worker; }
  isClosing(sessionId: string): boolean { return this.jobs.has(sessionId); }
  async report(jobId: unknown, summary: unknown, toolCallId?: string): Promise<{ saved: true; closure: 'awaiting_turn_settlement' }> {
    requireValue(string(summary, 4000) && string(toolCallId, 256));
    const w = this.worker; requireValue(w && w.jobId === jobId && w.requested && !w.reporting && !w.saved && !w.invalidated);
    this.assertWorker(w); w.reporting = true; w.toolCallId = toolCallId;
    const reportEpoch = this.epoch;
    try {
      await this.ctx.send(w.coordinatorId, 'handoff_report', { jobId: w.jobId, instanceId: this.instanceId, summary });
      this.assertWorker(w); requireValue(!w.invalidated && this.epoch === reportEpoch);
      w.saved = true; w.epoch = reportEpoch;
      return { saved: true, closure: 'awaiting_turn_settlement' };
    } finally { w.reporting = false; }
  }
  async receive(kind: HandoffKind, from: string, payload: Record<string, unknown>): Promise<void> {
    validateHandoffPayload(kind, payload);
    const { config, me } = await this.ctx.state(); this.valid();
    const sender = config.agents.find(a => a.sessionId === from);
    const coordinatorMessage = ['close_prepare', 'close_request', 'close_commit'].includes(kind);
    requireValue(me && sender && (coordinatorMessage ? sender.coordinator && !me.coordinator : me.coordinator && !sender.coordinator));
    if (coordinatorMessage) {
      requireValue(this.ctx.provider && me.closeJob?.jobId === payload.jobId && pendingClose(me.closeJob));
      if (kind === 'close_prepare') {
        requireValue(!this.worker);
        const deadline = Date.parse(payload.deadlineAt as string);
        requireValue(deadline > Date.now() && deadline <= Date.now() + 120000);
        const w: WorkerPending = { jobId: payload.jobId as string, coordinatorId: from, deadline, requested: false, saved: false, reporting: false, invalidated: false, epoch: this.epoch, committed: false, timer: undefined as unknown as ReturnType<typeof setTimeout> };
        this.worker = w;
        w.timer = setTimeout(() => { if (this.worker === w) this.worker = undefined; }, deadline - Date.now());
        this.background(async () => {
          try {
            const identity = await this.ctx.provider!.getIdentity(); validateIdentity(identity);
            this.assertWorker(w); requireValue(identity.sessionId === me.sessionId);
            await this.ctx.send(from, 'close_identity', { jobId: w.jobId, instanceId: this.instanceId, identity });
          } catch { if (this.worker === w) { clearTimeout(w.timer); this.worker = undefined; } }
        });
        return;
      }
      const w = this.worker;
      requireValue(w && w.jobId === payload.jobId && payload.instanceId === this.instanceId && from === w.coordinatorId);
      this.assertWorker(w);
      if (kind === 'close_request') {
        requireValue(!w.requested); w.requested = true;
        this.ctx.deliver(`Coordinator requests a handoff for owned-pane closure. Job ID: ${w.jobId}. Stop taking new assignments, summarize completed work, remaining work, validation and important files in intercom_report_handoff({jobId:"${w.jobId}",summary:...}) (public summary, max 4000 characters; no credentials or private reasoning), then finish this turn and wait. Do not exit, shut down, close a pane or start further work. Pane closure is asynchronous and is not proof all child processes terminated.`);
        return;
      }
      requireValue(w.saved && !w.reporting && !w.invalidated && !w.committed && !this.ctx.busy() && w.epoch === this.epoch && w.readyNonce === payload.readyNonce);
      w.committed = true; return;
    }
    const p = this.jobs.get(from); requireValue(p && p.job.jobId === payload.jobId);
    this.assertJob(p);
    if (kind === 'close_identity') {
      requireValue(!p.identity && !p.processing && p.job.state === 'requested');
      const identity = payload.identity as WorkerPaneIdentity;
      requireValue(identity.sessionId === from);
      p.identity = { ...identity }; p.instanceId = payload.instanceId as string; p.processing = true;
      this.background(async () => {
        try {
          await this.ctx.provider!.inspect(p.identity!, from, () => this.assertJob(p));
          this.assertJob(p);
          await this.transition(p, 'awaiting_handoff');
          await this.ctx.send(from, 'close_request', { jobId: p.job.jobId, instanceId: p.instanceId });
        } catch { await this.finish(p, 'failed', 'identity_failed'); }
        finally { p.processing = false; }
      });
      return;
    }
    requireValue(payload.instanceId === p.instanceId);
    if (kind === 'handoff_report') {
      requireValue(p.job.state === 'awaiting_handoff' || p.job.state === 'awaiting_settlement');
      try {
        await this.ctx.update(c => {
          const a = this.target(c, p);
          if (a.handoff?.jobId === p.job.jobId) requireValue(a.handoff.summary === payload.summary);
          else a.handoff = { version: 1, jobId: p.job.jobId, summary: payload.summary as string, updatedAt: new Date().toISOString() };
          a.closeJob = { ...a.closeJob!, state: 'awaiting_settlement', updatedAt: new Date().toISOString() };
        }, () => this.assertJob(p));
        this.assertJob(p); p.job = { ...p.job, state: 'awaiting_settlement' };
      } catch (error) { await this.finish(p, 'failed', 'save_failed'); throw error; }
      return;
    }
    requireValue(kind === 'close_ready' && p.job.state === 'awaiting_settlement' && !p.closing && !p.processing);
    p.processing = true;
    this.background(async () => {
      let failure: CloseReason = 'identity_failed';
      try {
        await this.transition(p, 'ready');
        await this.ctx.provider!.inspect(p.identity!, from, () => this.assertJob(p));
        this.assertJob(p);
        failure = 'save_failed'; await this.transition(p, 'closing');
        this.assertJob(p); failure = 'close_failed';
        let commitAttempted = false;
        const result = await this.ctx.provider!.close(p.identity!, from, () => this.assertJob(p), async () => {
          this.assertJob(p); requireValue(!commitAttempted); commitAttempted = true;
          failure = 'commit_rejected';
          await this.ctx.send(from, 'close_commit', { jobId: p.job.jobId, instanceId: p.instanceId, readyNonce: payload.readyNonce });
          this.assertJob(p); p.closing = true; failure = 'close_failed';
        });
        this.assertJob(p); requireValue(p.closing);
        await this.finish(p, result.paneClosed && result.workerExited ? 'closed' : 'uncertain', result.paneClosed && result.workerExited ? undefined : 'close_unverified');
      } catch { await this.finish(p, p.closing ? 'uncertain' : 'failed', failure); }
    });
  }
}
