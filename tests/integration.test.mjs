import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore } from '../dist/config.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-integration-'));
  let nextPort = 30000;
  const endpoints = new Map(), all = [], wire = [], launches = [];
  const options = {
    listen: async (_port, accept) => {
      const port = nextPort++; endpoints.set(port, accept);
      return { port, close: async () => { endpoints.delete(port); } };
    },
    send: async (port, message) => {
      wire.push({ port, message });
      const accept = endpoints.get(port); if (!accept) throw new Error('unreachable');
      await accept(message);
    },
    launch: async r => { launches.push(r); return { launched: true }; },
  };
  async function start(id) {
    const messages = [], notices = [], names = [];
    const host = { cwd: root, sessionId: () => id, busy: () => false,
      deliver: (text, busy) => messages.push({ text, busy }), setName: async name => { names.push(name); }, notify: text => notices.push(text),
      abort: () => assert.fail('must not abort'), shutdown: () => assert.fail('must not shutdown') };
    const runtime = new Intercom(host, options); all.push(runtime); await runtime.start();
    return { runtime, host, messages, notices, names };
  }
  t.after(async () => { for (const r of all) await r.close(); await rm(root, { recursive: true, force: true }); });
  return { start, endpoints, wire, launches, root };
}
async function configured(t) {
  const f = await setup(t), c = await f.start('c'), w = await f.start('w');
  await c.runtime.tool('configure_worker', { sessionId: 'w', port: w.runtime.endpoint.port, projectDirectory: '.', name: 'Builder', description: 'Build assigned tasks' });
  await c.runtime.tool('reload_worker', { to: 'Builder' });
  return { ...f, c, w };
}
test('anonymous registration explicitly hands ID/port/directory to agent, configure writes only, reload passive', async t => {
  const f = await setup(t), c = await f.start('c');
  assert.equal(c.messages.length, 0); assert.deepEqual(c.names, ['Coordinator']);
  c.host.busy = () => true;
  const w = await f.start('w');
  assert.equal(c.messages.length, 1); assert.equal(c.messages[0].busy, true);
  assert.match(c.messages[0].text, /registration/); assert.match(c.messages[0].text, /"sessionId":"w"/);
  assert.match(c.messages[0].text, /"projectDirectory":"\."/);
  assert.equal((await c.runtime.store.read()).agents.length, 1);
  await assert.rejects(w.runtime.tool('create_worker', {}), /permission/);
  await assert.rejects(w.runtime.tool('send', { to: 'Coordinator', message: 'x' }), /anonymous/);
  await c.runtime.tool('configure_worker', { sessionId: 'w', port: w.runtime.endpoint.port, projectDirectory: '.', name: 'Builder', description: 'Remit' });
  assert.equal(w.runtime.responsibility, undefined); assert.equal(w.messages.length, 0);
  await c.runtime.tool('reload_worker', { to: 'bUILDER' });
  assert.equal(w.runtime.responsibility.description, 'Remit'); assert.deepEqual(w.names, ['Builder']); assert.equal(w.messages.length, 0);
});
test('idle/steering messages and independent status reports share reporting without worker turn', async t => {
  const { c, w, wire } = await configured(t);
  await c.runtime.tool('send', { to: 'Builder', message: 'Implement the assigned task' });
  assert.equal(w.messages.at(-1).busy, false);
  w.host.busy = () => true;
  await c.runtime.tool('send', { to: 'Builder', message: 'Report progress and continue' });
  assert.equal(w.messages.at(-1).busy, true);
  const before = w.messages.length;
  await c.runtime.tool('request_status', { to: 'Builder' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(w.messages.length, before);
  assert.match(c.messages.at(-1).text, /"busy":true/);
  assert.ok(wire.some(x => x.message.kind === 'request_status'));
  assert.ok(wire.some(x => x.message.kind === 'status'));
  await assert.rejects(c.runtime.tool('report_status', {}), /worker-only/);
});
test('unknown status does not register; current port changes are bookkeeping; every send rereads', async t => {
  const { c, w, endpoints, wire } = await configured(t);
  const oldPort = w.runtime.endpoint.port, newPort = 40001;
  const handler = endpoints.get(oldPort); endpoints.delete(oldPort); endpoints.set(newPort, handler);
  w.runtime.endpoint.port = newPort;
  await w.runtime.report();
  assert.equal((await c.runtime.store.read()).agents.find(a => a.sessionId === 'w').port, newPort);
  await c.runtime.tool('send', { to: 'Builder', message: 'hello' });
  assert.equal(wire.at(-1).port, newPort);
  await c.runtime.receive({ version: 1, kind: 'status', from: 'removed', to: 'c', payload: { port: 40003, busy: false } });
  assert.equal((await c.runtime.store.read()).agents.length, 2);
  assert.match(c.messages.at(-1).text, /"configured":false/);
});
test('recipient and control role validation; stop/close fail before any transport/host cancellation', async t => {
  const { c, w, wire } = await configured(t);
  await assert.rejects(w.runtime.receive({ version: 1, kind: 'reload', from: 'c', to: 'not-w', payload: {} }), /mismatch/);
  await assert.rejects(w.runtime.receive({ version: 1, kind: 'reload', from: 'w', to: 'w', payload: {} }), /coordinator sender/);
  for (const op of ['stop_worker', 'close_worker']) {
    const before = wire.length;
    await assert.rejects(c.runtime.tool(op, { to: 'Builder' }), /Unsupported Pi host/);
    assert.equal(wire.length, before);
  }
  for (const kind of ['stop', 'close']) await assert.rejects(w.runtime.receive({ version: 1, kind, from: 'c', to: 'w', payload: {} }), /No cancellation or shutdown/);
});
test('coordinator unavailable leaves endpoint open; no retries/replacement and session cleanup', async t => {
  const { c, w, start, wire, endpoints } = await configured(t);
  await c.runtime.close();
  const n = await start('new-worker');
  assert.ok(endpoints.has(n.runtime.endpoint.port));
  assert.match(n.notices.join('\n'), /unreachable/);
  const before = wire.length;
  await assert.rejects(w.runtime.tool('send', { to: 'Coordinator', message: 'result' }), /unreachable/);
  assert.equal(wire.length, before + 1);
  const port = w.runtime.endpoint.port;
  await w.runtime.close(); assert.equal(endpoints.has(port), false);
  await assert.rejects(w.runtime.tool('list', {}), /inactive/);
});
test('resume, launcher setting and explicit removal do not orchestrate other actions', async t => {
  const { c, w, launches } = await configured(t);
  await c.runtime.tool('set_multiplexer', { multiplexer: 'none' });
  await c.runtime.tool('resume_worker', { to: 'Builder' });
  assert.equal(launches.at(-1).sessionId, 'w'); assert.equal(launches.at(-1).multiplexer, 'none');
  await w.runtime.close();
  await c.runtime.tool('remove_worker', { to: 'Builder' });
  assert.equal((await c.runtime.store.read()).agents.length, 1);
});
test('existing worker startup restores role/name, reports new port and starts no work', async t => {
  const { c, w, start } = await configured(t);
  const oldPort = w.runtime.endpoint.port;
  await w.runtime.close();
  const resumed = await start('w');
  assert.equal(resumed.runtime.responsibility.name, 'Builder');
  assert.deepEqual(resumed.names, ['Builder']);
  assert.equal(resumed.messages.length, 0);
  assert.notEqual(resumed.runtime.endpoint.port, oldPort);
  assert.equal((await c.runtime.store.read()).agents.find(a => a.sessionId === 'w').port, resumed.runtime.endpoint.port);
  assert.match(c.messages.at(-1).text, /Intercom status/);
});
test('close or session switch during directory resolution prevents create/resume launch', async t => {
  for (const operation of ['create_worker', 'resume_worker']) {
    for (const transition of ['close', 'switch']) {
      const { c, launches } = await configured(t);
      const store = c.runtime.store, root = store.root;
      let invalidated = false, closing;
      Object.defineProperty(store, 'root', { get() {
        if (!invalidated) {
          invalidated = true;
          queueMicrotask(() => {
            if (transition === 'close') closing = c.runtime.close();
            else c.host.sessionId = () => 'fork';
          });
        }
        return root;
      } });
      await assert.rejects(c.runtime.tool(operation, { to: 'Builder' }), /inactive|replaced/);
      await closing;
      assert.equal(launches.length, 0);
    }
  }
});
test('close invalidates queued coordinator tool and status writes', async t => {
  for (const operation of ['configure_worker', 'set_multiplexer', 'remove_worker', 'status']) {
    const { c } = await configured(t);
    const store = c.runtime.store, original = await store.read();
    let release, entered, queued;
    const started = new Promise(resolve => { entered = resolve; });
    const blocker = store.update('c', async () => { entered(); await new Promise(resolve => { release = resolve; }); });
    await started;
    const reachedQueue = new Promise(resolve => { queued = resolve; });
    const update = store.update.bind(store);
    store.update = (...args) => { queued(); return update(...args); };
    const pending = operation === 'status'
      ? c.runtime.receive({ version: 1, kind: 'status', from: 'w', to: 'c', payload: { port: 49999, busy: false } })
      : c.runtime.tool(operation, { to: 'Builder', multiplexer: 'none', sessionId: 'w2', name: 'Other', port: 40001, projectDirectory: '.', description: 'Other remit' });
    const rejected = assert.rejects(pending, /inactive|replaced/);
    await reachedQueue;
    await c.runtime.close(); release(); await blocker; await rejected;
    assert.deepEqual(await store.read(), original);
  }
});
test('close while listener startup is pending disposes the late endpoint', async t => {
  const { c, endpoints } = await configured(t);
  await c.runtime.close();
  const listen = c.runtime.options.listen;
  let release, entered, latePort;
  const started = new Promise(resolve => { entered = resolve; });
  c.runtime.options.listen = async (...args) => {
    const endpoint = await listen(...args); latePort = endpoint.port;
    entered(); await new Promise(resolve => { release = resolve; });
    return endpoint;
  };
  const pending = c.runtime.start();
  const rejected = assert.rejects(pending, /inactive|replaced/);
  await started; await c.runtime.close(); release(); await rejected;
  assert.equal(endpoints.has(latePort), false);
  assert.equal(c.runtime.endpoint, undefined);
});
test('anonymous startup cannot register across a directory-resolution lifecycle change', async t => {
  const { c, wire, root } = await configured(t);
  let runtime, invalidated = false, closing;
  runtime = new Intercom({ cwd: root, sessionId: () => 'anonymous', busy: () => false,
    deliver: () => {}, setName: async () => {}, notify: () => {} }, {
    ...c.runtime.options,
    store: base => {
      const store = new ConfigStore(base);
      Object.defineProperty(store, 'root', { get() {
        if (!invalidated) {
          invalidated = true;
          queueMicrotask(() => {
            closing = runtime.close();
            // Simulate the same object's next active lifecycle before realpath completes.
            runtime.active = true;
            runtime.endpoint = { port: 49999, close: async () => {} };
          });
        }
        return base;
      } });
      return store;
    },
  });
  t.after(() => runtime.close());
  const before = wire.length;
  await assert.rejects(runtime.start(), /lifecycle replaced/);
  await closing;
  assert.equal(wire.length, before);
});
test('deferred status from a closed lifecycle does not report after restart', async t => {
  const { c, w, wire } = await configured(t);
  await w.runtime.receive({ version: 1, kind: 'request_status', from: 'c', to: 'w', payload: {} });
  await w.runtime.close();
  // Reactivate synchronously to exercise the generation check, not just active=false.
  w.runtime.active = true; w.runtime.initialId = 'w';
  const before = wire.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.length, before);
  assert.equal(w.notices.some(text => text.startsWith('Status report failed:')), false);
});
test('live session ID changes invalidate old runtime rather than granting cached role', async t => {
  const { c } = await configured(t);
  c.host.sessionId = () => 'fork-id';
  await assert.rejects(c.runtime.tool('create_worker', {}), /replaced/);
});
