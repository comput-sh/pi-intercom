import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { visibleWidth } from 'pi-intercom-tui';
import { createMonitor, parseMonitorRoot } from '../dist/monitor.js';
import { renderMonitor } from '../dist/monitor-view.js';

const now = Date.parse('2026-09-26T12:00:00.000Z');
const snapshot = () => ({ version: 1, generatedAt: new Date(now).toISOString(), staleAfterMs: 60000,
  config: { multiplexer: 'herdr', agents: [{ sessionId: 'w', name: 'Worker宽', description: 'Review only', coordinator: false }] },
  events: [{ sessionId: 'w', event: 'host.activity', busy: true, timestamp: new Date(now - 70000).toISOString() }],
  errors: [], truncated: false });
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(read, extra = {}) {
  let rows = 8, renders = 0, quits = 0;
  const pending = new Set();
  const monitor = createMonitor('/unused', {
    ...extra, read, rows: () => rows, now: extra.now ?? (() => now), color: false,
    requestRender: () => { renders++; }, onQuit: () => { quits++; },
    schedule(callback, delay) {
      assert.equal(delay, 3000);
      pending.add(callback);
      return () => pending.delete(callback);
    },
  });
  return { monitor, pending, setRows(value) { rows = value; },
    get renders() { return renders; }, get quits() { return quits; },
    tick() { const callbacks = [...pending]; pending.clear(); callbacks.forEach(callback => callback()); },
  };
}

test('root parser requires exactly one absolute root; import has no terminal startup', () => {
  const root = path.resolve('project');
  assert.equal(parseMonitorRoot(['--root', root]), root);
  assert.equal(parseMonitorRoot(['--root', '/project']), path.normalize('/project'));
  for (const args of [[], ['--root'], ['--root', 'relative'], ['--other', root], ['--root', root, 'extra']]) {
    assert.throws(() => parseMonitorRoot(args), /Usage:/);
  }
});

test('refresh is nonoverlapping, failure degrades and next refresh recovers', async () => {
  let resolve, calls = 0;
  const h = harness(() => { calls++; return new Promise(r => { resolve = r; }); });
  h.monitor.start(); h.monitor.start();
  assert.equal(calls, 1);
  h.tick(); assert.equal(calls, 1);
  assert.match(h.monitor.render(100).join('\n'), /unavailable/);
  resolve(snapshot()); await settle();
  assert.equal(h.pending.size, 1);
  assert.match(h.monitor.render(140).join('\n'), /\(old\)/);
  assert.match(h.monitor.render(140).join('\n'), /working/);
  h.tick(); assert.equal(calls, 2);
  assert.equal(h.pending.size, 0);
  h.monitor.close(); resolve(snapshot()); await settle();
  assert.equal(h.renders, 1); assert.equal(h.pending.size, 0);

  let attempt = 0;
  const f = harness(async () => { if (++attempt === 1) throw new Error('private detail'); return snapshot(); });
  f.monitor.start(); await settle();
  assert.match(f.monitor.render(100).join('\n'), /unavailable/);
  assert.doesNotMatch(f.monitor.render(100).join('\n'), /private detail/);
  f.tick(); await settle();
  assert.match(f.monitor.render(100).join('\n'), /Worker/);
  f.monitor.close(); assert.equal(f.pending.size, 0);
});

test('quit keys close immediately while a read is pending, without late renders', async () => {
  for (const key of ['q', '\x1b', '\x03']) {
    let resolve;
    const h = harness(() => new Promise(r => { resolve = r; }));
    h.monitor.start(); h.monitor.handleInput('x'); assert.equal(h.quits, 0);
    h.monitor.handleInput(key); h.monitor.handleInput(key); h.monitor.close();
    assert.equal(h.quits, 1);
    resolve(snapshot()); await settle();
    assert.equal(h.renders, 0); assert.equal(h.pending.size, 0);
    h.monitor.start(); assert.equal(h.pending.size, 0);
  }
});

test('keyboard selects workers, follows identity through reorder and clamps removal', async () => {
  let s = snapshot();
  const roster = Array.from({ length: 15 }, (_, i) => ({ sessionId: `worker-${i}`, name: `Worker-${i}`, description: `Responsibility-${i}`, coordinator: false }));
  s.config.agents = [{ sessionId: 'coordinator', name: 'Main', coordinator: true }, ...roster];
  const h = harness(async () => s);
  const check = (selectedIndex, details = false) => assert.deepEqual(h.monitor.render(140), renderMonitor(s, 140, 8, now, false, { selectedIndex, details }));
  h.monitor.start(); await settle(); check(0);
  const renders = h.renders;
  h.monitor.handleInput('\x1b[A'); check(0); assert.equal(h.renders, renders);
  for (let i = 0; i < 20; i++) h.monitor.handleInput('\x1b[B');
  check(14); assert.match(h.monitor.render(140).join('\n'), /Worker-14/);
  h.monitor.handleInput('\r'); check(14, true);
  h.monitor.handleInput('\x1b[A'); check(13, true);
  s = { ...s, config: { ...s.config, agents: [...roster].reverse() } };
  h.tick(); await settle(); check(1, true);
  s = { ...s, config: { ...s.config, agents: [roster[0]] } };
  h.tick(); await settle(); check(0, true);
  h.monitor.handleInput('\x1b'); check(0); assert.equal(h.quits, 0);
  h.monitor.handleInput('\r'); check(0, true);
  h.monitor.handleInput('\r'); check(0);
  s = { ...s, config: { ...s.config, agents: [] } };
  h.tick(); await settle(); check(-1);
  h.monitor.handleInput('\r'); h.monitor.handleInput('\x1b[B'); check(-1);
  h.monitor.handleInput('\x1b'); assert.equal(h.quits, 1);
});

test('transient snapshot failure preserves selected identity and q quits details', async () => {
  let s = snapshot();
  s.config.agents.push({ sessionId: 'second', name: 'Second', description: 'Read only', coordinator: false });
  let fail = false;
  const h = harness(async () => { if (fail) throw new Error('private'); return s; });
  h.monitor.start(); await settle();
  h.monitor.handleInput('\x1b[B'); h.monitor.handleInput('\r');
  fail = true; h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /unavailable/);
  fail = false; s = { ...s, config: { ...s.config, agents: [...s.config.agents].reverse() } };
  h.tick(); await settle();
  assert.deepEqual(h.monitor.render(140), renderMonitor(s, 140, 8, now, false, { selectedIndex: 0, details: true }));
  h.monitor.handleInput('q'); assert.equal(h.quits, 1); assert.equal(h.pending.size, 0);
  const renders = h.renders;
  h.monitor.handleInput('\x1b[B'); h.monitor.handleInput('\r');
  assert.equal(h.renders, renders);
});

test('render honors current height and width on every frame, including tiny panes', async () => {
  const s = snapshot();
  s.config.agents[0].name = '\x1b[31m宽名\x1b[0m\n';
  const h = harness(async () => s);
  h.monitor.start(); await settle();
  for (const height of [0, 1, 2, 4, 20]) {
    h.setRows(height);
    for (const width of [0, 1, 5, 30, 120]) {
      const lines = h.monitor.render(width);
      assert.ok(lines.length <= height);
      if (!width) assert.deepEqual(lines, []);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width);
        assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
      }
    }
  }
  h.monitor.close();
});

const connection = (sessionId, state, reason = state === 'connected' ? 'verified' : 'refused', checkedAt = now) => ({
  sessionId, state, reason, checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
});
test('explicit probes are nonoverlapping and aborted on close without late render', async () => {
  let resolve, signal, calls = 0;
  const h = harness(async () => snapshot(), { probe: async (_workers, options) => {
    calls++; signal = options.signal;
    return new Promise(r => { resolve = r; });
  } });
  h.monitor.start(); await settle(); h.tick();
  assert.equal(calls, 1); assert.equal(h.renders, 0); assert.equal(h.pending.size, 0);
  h.monitor.handleInput('q'); assert.equal(signal.aborted, true);
  resolve([connection('w', 'disconnected')]); await settle();
  assert.equal(h.renders, 0); assert.equal(h.pending.size, 0);
});
test('connectivity sorting preserves selected identity in details and when checks expire', async () => {
  const s = snapshot();
  s.config.agents.push({ sessionId: 'b', name: 'Second', description: 'Second responsibility' });
  let time = now;
  const h = harness(async () => s, { now: () => time });
  h.setRows(20); h.monitor.start(); await settle(); h.monitor.handleInput('\r');
  s.connections = [connection('w', 'disconnected'), connection('b', 'connected')];
  h.tick(); await settle();
  let lines = h.monitor.render(140);
  assert.ok(lines.findIndex(line => line.includes('Second')) < lines.findIndex(line => line.includes('Worker宽')));
  assert.match(lines.join('\n'), /› Worker宽.*disconnected/);
  assert.match(lines.join('\n'), /Responsibility: Review only/);
  time += 31000;
  lines = h.monitor.render(140);
  assert.match(lines.join('\n'), /› Worker宽.*unknown/);
  h.monitor.handleInput('\x1b[B');
  assert.match(h.monitor.render(140).join('\n'), /› Second.*unknown/);
  h.monitor.close();
});
test('rotated bounded probes retain not_checked evidence, then expire it truthfully', async () => {
  const s = snapshot();
  s.config.agents = Array.from({ length: 300 }, (_, i) => ({ sessionId: `w${i}`, name: `Worker-${i}`, port: 10000 + i }));
  const starts = []; let time = now;
  const h = harness(async () => s, { now: () => time, probe: async workers => {
    assert.equal(workers.length, 256); starts.push(workers[0].sessionId);
    return workers.map((worker, i) => i === 0
      ? connection(worker.sessionId, 'disconnected', 'refused', time)
      : connection(worker.sessionId, 'unknown', 'not_checked', null));
  } });
  h.setRows(310); h.monitor.start(); await settle(); h.tick(); await settle();
  assert.deepEqual(starts, ['w0', 'w1']);
  // w1 was previously not checked, and w0 is outside this rotated slice.
  assert.match(h.monitor.render(140).join('\n'), /Worker-0\s+disconnected/);
  time += 31000;
  assert.match(h.monitor.render(140).join('\n'), /Worker-0\s+unknown/);
  h.monitor.close();
});
test('saved endpoint changes and removal invalidate cached checks without losing selection', async () => {
  let s = snapshot(), calls = 0;
  s.config.agents[0].port = 12000;
  s.config.agents.push({ sessionId: 'b', name: 'Second', port: 12001 });
  const h = harness(async () => s, { probe: async workers => {
    calls++;
    return workers.map(worker => calls === 1 || calls === 3
      ? connection(worker.sessionId, worker.sessionId === 'w' ? 'disconnected' : 'connected')
      : connection(worker.sessionId, 'unknown', 'not_checked', null));
  } });
  h.setRows(20); h.monitor.start(); await settle();
  // Sorted first roster selects Second; explicitly select the disconnected worker.
  h.monitor.handleInput('\x1b[B'); h.monitor.handleInput('\r');
  assert.match(h.monitor.render(140).join('\n'), /› Worker宽\s+disconnected/);
  s = { ...s, config: { ...s.config, agents: s.config.agents.map(worker => worker.sessionId === 'w' ? { ...worker, port: 12002 } : worker) } };
  h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /› Worker宽\s+unknown/);
  assert.match(h.monitor.render(140).join('\n'), /Checked: never/);
  assert.match(h.monitor.render(140).join('\n'), /Responsibility: Review only/);
  h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /› Worker宽\s+disconnected/);
  const saved = s.config.agents[0];
  s = { ...s, config: { ...s.config, agents: s.config.agents.slice(1) } };
  h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /› Second\s+connected/);
  s = { ...s, config: { ...s.config, agents: [saved, ...s.config.agents] } };
  h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /Worker宽\s+unknown/);
  assert.match(h.monitor.render(140).join('\n'), /› Second\s+connected/);
  h.monitor.close();
});
test('not_checked result does not overwrite a prior verified check', async () => {
  let calls = 0, time = now;
  const h = harness(async () => snapshot(), { now: () => time, probe: async () => ++calls === 1
    ? [connection('w', 'disconnected')]
    : [connection('w', 'unknown', 'not_checked', null)] });
  h.monitor.start(); await settle(); h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /Worker宽\s+disconnected/);
  time += 31000; h.tick(); await settle();
  assert.match(h.monitor.render(140).join('\n'), /Worker宽\s+unknown/);
  h.monitor.close();
});
