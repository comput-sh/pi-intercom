#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Key, matchesKey, ProcessTerminal, TuiAltScreen, type Component, type TUI } from 'pi-intercom-tui';
import { readObservationSnapshot, type ObservationSnapshot } from './snapshot.js';
import { renderMonitor } from './monitor-view.js';
import { probeWorkers, sortWorkersByConnection, type WorkerConnection } from './connections.js';

export function parseMonitorRoot(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--root' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: node dist/monitor.js --root <absolute-project-path>');
  }
  return path.normalize(args[1]);
}

export interface MonitorOptions {
  read?: typeof readObservationSnapshot;
  /** Injected readers do not probe unless explicitly supplied. */
  probe?: typeof probeWorkers;
  rows: () => number;
  requestRender: () => void;
  onQuit: () => void;
  intervalMs?: number;
  color?: boolean;
  now?: () => number;
  /** Returns a cancellation function; injected by deterministic tests. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Read-only snapshots and bounded health checks. Closing never awaits pending IO. */
export function createMonitor(root: string, options: MonitorOptions): Component & { start(): void; close(): void } {
  let snapshot: ObservationSnapshot | undefined;
  let selectedIndex = -1;
  let selectedSessionId: string | undefined;
  let details = false;
  const now = options.now ?? Date.now;
  const workers = (at = now()) => sortWorkersByConnection(snapshot?.config?.agents.filter(agent => !agent.coordinator) ?? [], snapshot?.connections, at);
  const probe = options.probe ?? (options.read ? undefined : probeWorkers);
  const abort = new AbortController();
  let connections: WorkerConnection[] = [];
  let connectionPorts = new Map<string, number>();
  let probeStart = 0;
  const selection = (at = now()) => {
    const roster = workers(at);
    const index = roster.findIndex(worker => worker.sessionId === selectedSessionId);
    return { roster, index: index >= 0 ? index : selectedIndex };
  };
  const requestRender = () => { try { options.requestRender(); } catch { /* UI shutdown is independent of reading. */ } };
  let closed = false, started = false;
  let cancel: (() => void) | undefined;
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  });
  const interval = Math.max(100, options.intervalMs ?? 3000);
  async function refresh(): Promise<void> {
    if (closed) return;
    let next: ObservationSnapshot | undefined;
    try { next = await (options.read ?? readObservationSnapshot)(root); } catch { /* Unavailable, no raw errors. */ }
    if (closed) return;
    if (next?.config && probe) {
      const roster = next.config.agents.filter(agent => !agent.coordinator);
      const start = roster.length ? probeStart % roster.length : 0;
      const rotated = [...roster.slice(start), ...roster.slice(0, start)].slice(0, 256);
      let checked: WorkerConnection[] = [];
      try { checked = await probe(rotated, { signal: abort.signal }); } catch { /* Preserve prior checks until stale. */ }
      if (closed) return;
      // A check belongs to a saved endpoint, not just a session identity. Keep
      // the last successful roster across read failures, but retire removed IDs
      // and invalidate cached evidence when their configured port changes.
      const ports = new Map(roster.map(worker => [worker.sessionId, worker.port]));
      const previous = new Map(connections
        .filter(connection => ports.has(connection.sessionId) && connectionPorts.get(connection.sessionId) === ports.get(connection.sessionId))
        .map(connection => [connection.sessionId, connection]));
      connectionPorts = ports;
      for (const connection of checked) {
        if (connection.reason !== 'not_checked' || !previous.has(connection.sessionId)) previous.set(connection.sessionId, connection);
      }
      connections = roster.flatMap(worker => {
        const connection = previous.get(worker.sessionId);
        return connection ? [connection] : [];
      });
      probeStart = start + Math.max(1, checked.filter(connection => connection.reason !== 'not_checked').length);
      next = { ...next, connections };
    }
    snapshot = next;
    // Preserve identity through reordering, and retain it across transient read failures.
    if (snapshot?.config) {
      const roster = workers();
      const previous = roster.findIndex(agent => agent.sessionId === selectedSessionId);
      selectedIndex = roster.length ? (previous >= 0 ? previous : Math.max(0, Math.min(selectedIndex, roster.length - 1))) : -1;
      selectedSessionId = roster[selectedIndex]?.sessionId;
      if (selectedIndex < 0) details = false;
    }
    requestRender();
    if (!closed) cancel = schedule(() => { cancel = undefined; void refresh(); }, interval);
  }
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    cancel?.(); cancel = undefined;
  };
  return {
    start() { if (started || closed) return; started = true; void refresh(); },
    close,
    invalidate() {},
    render(width) {
      const height = Math.max(0, Math.floor(options.rows()));
      if (width <= 0 || !height) return [];
      const at = now();
      const view = { selectedIndex: snapshot?.config ? selection(at).index : -1, details: !!snapshot?.config && details };
      try { return renderMonitor(snapshot, width, height, at, options.color, view); }
      catch { return renderMonitor(undefined, width, height, Date.now(), options.color, { selectedIndex: -1, details: false }); }
    },
    handleInput(data) {
      if (closed) return;
      if (matchesKey(data, Key.escape) && details) {
        details = false; requestRender(); return;
      }
      if (matchesKey(data, 'q') || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
        close(); options.onQuit(); return;
      }
      const { roster, index } = selection();
      selectedIndex = index;
      if (!roster.length) return;
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        const next = Math.max(0, Math.min(roster.length - 1, selectedIndex + (matchesKey(data, Key.up) ? -1 : 1)));
        if (next !== selectedIndex) {
          selectedIndex = next; selectedSessionId = roster[next].sessionId; requestRender();
        }
      } else if (matchesKey(data, Key.enter)) {
        details = !details; requestRender();
      }
    },
  };
}

/** CLI-only setup: importing this module never touches raw mode or project files. */
export function runMonitor(args = process.argv.slice(2)): void {
  const root = parseMonitorRoot(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Intercom monitor requires an interactive terminal.');
  // pi-tui supports optional disk diagnostics; this read-only process must not enable them.
  delete process.env.PI_TUI_WRITE_LOG;
  delete process.env.PI_TUI_DEBUG;
  delete process.env.PI_DEBUG_REDRAW;
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    monitor.close();
    process.removeListener('SIGINT', signalQuit);
    process.removeListener('SIGTERM', signalQuit);
    process.removeListener('exit', stop);
    try { tui.stop(); } finally { terminal.stop(); }
  };
  // Explicit exit after restoring the terminal: an unresponsive filesystem read
  // must not hold the standalone process open after the owner requests quit.
  const quit = () => { stop(); process.exit(0); };
  const signalQuit = () => quit();
  const monitor = createMonitor(root, {
    rows: () => terminal.rows,
    color: process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
    requestRender: () => tui.requestRender(),
    onQuit: quit,
  });
  tui.addChild(monitor);
  tui.setFocus(monitor);
  process.on('SIGINT', signalQuit);
  process.on('SIGTERM', signalQuit);
  process.on('exit', stop);
  try { tui.start(); monitor.start(); }
  catch (error) { stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runMonitor(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Intercom monitor unavailable.');
    process.exitCode = 1;
  }
}
