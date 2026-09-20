import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Type, type TSchema } from 'typebox';
import { getAgentDir, SessionManager, SettingsManager, truncateHead, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ConfigStore } from './config.js';
import { Intercom, UNSUPPORTED_CANCELLATION } from './runtime.js';
import { launchers } from './launcher.js';
import { startDashboard, type Dashboard } from './dashboard.js';

const to = Type.Object({ to: Type.String({ minLength: 1, maxLength: 128 }) });
const tools: [string, string, TSchema][] = [
  ['create_worker', 'Coordinator only. Launch one anonymous worker in projectDirectory (default root). No assignment, configuration, or registration wait.', Type.Object({ projectDirectory: Type.Optional(Type.String()) })],
  ['configure_worker', 'Coordinator only. Write explicit reported connection details and responsibility to config. Does not notify, reload, or start work. Use reload_worker separately.', Type.Object({ sessionId: Type.String(), port: Type.Integer({ minimum: 1, maximum: 65535 }), projectDirectory: Type.String(), name: Type.String({ minLength: 1, maxLength: 128 }), description: Type.String({ minLength: 1, maxLength: 4096 }) })],
  ['reload_worker', 'Coordinator only. Ask worker to reread responsibility and synchronize names. NOT Pi extension reload, cancellation, restart, or work assignment.', to],
  ['send', 'Configured sessions only. Send an explicit work/progress/findings message by recipient name. Idle delivery starts a turn; busy delivery steers at supported boundaries. Receipt is not an agent reply. Progress questions do not cancel assignments.', Type.Object({ to: Type.String(), message: Type.String({ minLength: 1, maxLength: 48000 }) })],
  ['list', 'Configured sessions only. Read current saved names, responsibilities, session IDs, roles and ports. No live probing. Output limited to 50 KiB/2000 lines; full data remains in config.json.', Type.Object({})],
  ['request_status', 'Coordinator only. Ask worker extension to send an independent sessionId/port/busy report without a model turn on worker. No synchronous status reply.', to],
  ['report_status', 'Worker only (including anonymous). Send runtime sessionId/port/busy report to coordinator. This is NOT registration and creates no config entry.', Type.Object({})],
  ['stop_worker', UNSUPPORTED_CANCELLATION, to],
  ['close_worker', UNSUPPORTED_CANCELLATION, to],
  ['resume_worker', 'Coordinator only. Launch saved session by ID in configured directory. No replacement/removal on failure; no old assignment is automatically started.', to],
  ['remove_worker', 'Coordinator only. Remove config entry only; never stop process or delete session files. A running worker must be explicitly closed before removal. Stop/close are disabled on current host: arrange explicit user closure first.', to],
  ['set_multiplexer', 'Coordinator only. Set herdr (default) or none (separate visible Windows terminals) for future launches. Never move/restart existing workers or fall back.', Type.Object({ multiplexer: Type.String({ enum: ['herdr', 'none'] }) })],
];

// Launchers pass no --session-dir. Match child Pi's env > per-cwd settings >
// default lookup, resolving relative paths against the child's cwd, not ours.
// SettingsManager's public getter applies Pi's own path/tilde normalization.
export function resumeSessionDirectory(cwd: string, envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR, agentDir = getAgentDir()): string | undefined {
  const settings = envSessionDir
    ? SettingsManager.inMemory({ sessionDir: envSessionDir })
    : SettingsManager.create(cwd, path.resolve(cwd, agentDir));
  const sessionDir = settings.getSessionDir();
  return sessionDir ? path.resolve(cwd, sessionDir) : undefined;
}

// Participate in Pi's own per-file mutation queue as well as Intercom serialization.
class PiConfigStore extends ConfigStore {
  override update(id: string, mutate: Parameters<ConfigStore['update']>[1], assertValid?: () => void) {
    return withFileMutationQueue(this.file, () => super.update(id, mutate, assertValid));
  }
}
export default function intercomExtension(pi: ExtensionAPI): void {
  let runtime: Intercom | undefined;
  let context: ExtensionContext | undefined;
  let dashboard: Dashboard | undefined;
  let generation = 0;
  const launcher = launchers({
    extension: fileURLToPath(import.meta.url),
    sessionExists: async (cwd, id) => (await SessionManager.list(cwd, resumeSessionDirectory(cwd))).some(s => s.id === id),
  });
  pi.on('session_start', async (_event, ctx) => {
    const started = ++generation;
    await dashboard?.close(); dashboard = undefined;
    await runtime?.close(); context = ctx;
    if (process.platform !== 'win32' || ctx.mode !== 'tui') throw new Error('PiIntercom V1 requires Windows interactive Pi. No resources started.');
    if (!ctx.isProjectTrusted()) throw new Error('PiIntercom requires project trust before honoring shared project configuration.');
    runtime = new Intercom({
      cwd: ctx.cwd,
      sessionId: () => context!.sessionManager.getSessionId(),
      busy: () => !context!.isIdle(),
      deliver: (content, busy) => pi.sendUserMessage(content, busy ? { deliverAs: 'steer' } : undefined),
      setName: async name => { if (pi.getSessionName() !== name) pi.setSessionName(name); await launcher.syncName(name); },
      notify: text => ctx.ui.notify(text, 'info'),
    }, { launch: launcher.launch, store: root => new PiConfigStore(root) });
    const current = runtime;
    try { await current.start(); }
    catch (e) { if (runtime === current) runtime = undefined; ctx.ui.notify(String(e), 'error'); return; }
    if (started !== generation) return;
    let server: Dashboard | undefined;
    let savingPort = false;
    try {
      if ((await current.state()).me?.coordinator) {
        server = await startDashboard(current.store.root);
        if (started !== generation) { await server.close(); return; }
        savingPort = true;
        await current.recordDashboardPort(server.port);
        if (started !== generation) { await server.close(); return; }
        dashboard = server;
        ctx.ui.notify(`Intercom read-only dashboard: ${server.url} (saved URL is last-known, not live availability)`, 'info');
      }
    } catch {
      await server?.close().catch(() => {});
      if (started !== generation) return;
      ctx.ui.notify(savingPort
        ? 'Intercom dashboard port could not be saved; the new dashboard was closed. Any saved URL is last-known only. Messaging remains available.'
        : 'Intercom dashboard unavailable; communication remains independent.', 'error');
    }
  });
  pi.on('session_shutdown', async () => {
    generation++;
    await dashboard?.close(); dashboard = undefined;
    await runtime?.close(); runtime = undefined; context = undefined;
  });
  pi.on('agent_start', async (_event, ctx) => {
    context = ctx;
    runtime?.recordObservation('host.activity', { busy: !ctx.isIdle(), outcome: 'started' });
  });
  pi.on('agent_settled', async (_event, ctx) => {
    context = ctx;
    runtime?.recordObservation('host.activity', { busy: !ctx.isIdle(), outcome: 'settled' });
  });
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx;
    if (!runtime) return;
    const { me } = await runtime.state();
    const loaded = runtime.responsibility;
    return { systemPrompt: event.systemPrompt + '\n\nPiIntercom: communicates; Pi decides orchestration. Responsibility is not a work assignment. Do not implement unrelated work from findings. After assigned work, report as instructed and wait; do not autonomously exit. Progress questions require reporting and continuing unless explicitly redirected. stop_worker/close_worker are disabled due to host cancellation blocker.\n' + (me && loaded ? `Identity: ${loaded.name} (${me.sessionId}). Responsibility: ${loaded.description}.` : 'Anonymous/unloaded worker: wait for coordinator configuration and separate reload; do not treat registration as authorization to work.') };
  });
  for (const [operation, description, parameters] of tools) {
    pi.registerTool({
      name: `intercom_${operation}`, label: `Intercom ${operation}`, description, parameters,
      async execute(_id, args, signal, _update, ctx) {
        signal?.throwIfAborted(); context = ctx;
        if (!runtime) throw new Error('PiIntercom not initialized; inspect startup error.');
        const result = await runtime.tool(operation, args as Record<string, unknown>);
        const output = truncateHead(JSON.stringify(result, null, 2));
        return { content: [{ type: 'text', text: output.content + (output.truncated ? `\n[Truncated; full shared configuration: ${runtime.store.file}]` : '') }], details: {} };
      },
    });
  }
}
