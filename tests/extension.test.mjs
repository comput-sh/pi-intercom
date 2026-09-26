import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../dist/index.js';
import { mkdtemp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../dist/config.js';
import { listen, send } from '../dist/transport.js';
import { readDashboardSnapshot } from '../dist/dashboard.js';

// These exercise the Windows/Linux adapter, but never construct a Pi host or launch a process.
async function adapter(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-adapter-'));
  // Isolate this fixture from real ancestor Intercom projects. Production discovery
  // policy is tested separately; adapter startup must never contact an ancestor host.
  const originalDiscover = ConfigStore.discover;
  ConfigStore.discover = async cwd => {
    assert.equal(path.resolve(cwd), path.resolve(root), 'adapter discovery must stay in its test root');
    const store = new ConfigStore(root);
    try { await store.read(); return store; }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const inheritedHerdr = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  const tools = new Map(), events = new Map(), messages = [], notices = [], names = [];
  let id = 'adapter-coordinator', idle = true, name = '', failName = false;
  const pi = {
    registerTool: tool => tools.set(tool.name, tool), on: (event, handler) => events.set(event, handler),
    getSessionName: () => name,
    setSessionName: value => { if (failName) throw new Error('injected name failure'); name = value; names.push(value); },
    sendUserMessage: (content, options) => messages.push({ content, options }),
  };
  extension(pi);
  const ctx = { cwd: root, mode: 'tui', isProjectTrusted: () => true, isIdle: () => idle,
    sessionManager: { getSessionId: () => id }, ui: { notify: (text, level) => notices.push({ text, level }) } };
  t.after(async () => {
    try { await events.get('session_shutdown')(); }
    finally {
      ConfigStore.discover = originalDiscover;
      if (inheritedHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = inheritedHerdr;
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, ctx, tools, events, messages, notices, names,
    setId: value => { id = value; }, setIdle: value => { idle = value; }, failName: value => { failName = value; },
    setDelivery: deliver => { pi.sendUserMessage = deliver; },
    start: () => events.get('session_start')({}, ctx),
    prompt: () => events.get('before_agent_start')({ systemPrompt: 'Original system prompt' }, ctx),
    invoke: (operation, args = {}) => tools.get(`intercom_${operation}`).execute('test', args, undefined, undefined, ctx) };
}
const supportedHost = { skip: !['win32', 'linux'].includes(process.platform) ? 'Windows/Linux extension startup adapter' : false };

test('single extension registers all agreed tools without starting resources in factory', async () => {
  const tools = new Map(), events = new Map();
  extension({ registerTool: t => tools.set(t.name, t), on: (name, handler) => events.set(name, handler) });
  assert.equal(tools.size, 12);
  assert.deepEqual([...events.keys()], ['session_start', 'session_shutdown', 'agent_start', 'agent_settled', 'before_agent_start']);
  const configure = tools.get('intercom_configure_worker');
  assert.deepEqual([...configure.parameters.required].sort(), ['description', 'name', 'port', 'projectDirectory', 'sessionId']);
  assert.match(tools.get('intercom_stop_worker').description, /disabled/);
  assert.match(tools.get('intercom_reload_worker').description, /NOT Pi extension reload/);
  await assert.rejects(tools.get('intercom_list').execute('test', {}, undefined, undefined, {}), /not initialized/);
  await events.get('session_shutdown')();
  await events.get('session_shutdown')();
});

test('adapter rejects untrusted/noninteractive startup before creating config', supportedHost, async t => {
  const a = await adapter(t);
  a.ctx.isProjectTrusted = () => false;
  await assert.rejects(a.start(), /trust/);
  await assert.rejects(access(path.join(a.root, '.pi-intercom', 'config.json')), /ENOENT/);
  await assert.rejects(a.invoke('list'), /not initialized/);
  a.ctx.isProjectTrusted = () => true; a.ctx.mode = 'rpc';
  await assert.rejects(a.start(), /interactive/);
  await assert.rejects(access(path.join(a.root, '.pi-intercom', 'config.json')), /ENOENT/);
  assert.equal(a.messages.length, 0);
});

test('adapter startup is passive, adds responsibility, routes idle/steering and replaces session listener', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  assert.equal(a.messages.length, 0);
  assert.deepEqual(a.names, ['Coordinator']);
  const prompt = await a.prompt();
  assert.match(prompt.systemPrompt, /^Original system prompt/);
  assert.match(prompt.systemPrompt, /Identity: Coordinator \(adapter-coordinator\)/);
  assert.match(prompt.systemPrompt, /Responsibility is not a work assignment/);
  const store = new ConfigStore(a.root), old = (await store.read()).agents[0];
  await a.invoke('send', { to: 'Coordinator', message: 'Idle message' });
  assert.deepEqual(a.messages.at(-1).options, { deliverAs: 'steer' });
  a.setIdle(false);
  await a.invoke('send', { to: 'Coordinator', message: 'Busy message' });
  assert.deepEqual(a.messages.at(-1).options, { deliverAs: 'steer' });
  // A replaced session must not inherit the old coordinator role or listener.
  a.setId('replacement-worker');
  await a.start();
  await assert.rejects(a.invoke('create_worker'), /permission/);
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  await assert.rejects(send(old.port, { version: 1, kind: 'message', from: old.sessionId, to: old.sessionId,
    payload: { message: 'Must not reach old session' } }));
  await a.events.get('session_shutdown')();
  await assert.rejects(a.invoke('list'), /not initialized/);
  assert.equal(await a.prompt(), undefined);
});

test('adapter always supplies steering: installed host keeps idle normal and handles idle-snapshot to busy-acceptance race', supportedHost, async t => {
  // Source-backed mocked compatibility probe, not a live Pi session. Deliberately
  // fail if the pinned host changes this branch rather than testing stale copied behavior.
  const hostSource = await readFile(fileURLToPath(new URL('./core/agent-session.js', import.meta.resolve('@earendil-works/pi-coding-agent'))), 'utf8');
  assert.match(hostSource, /streamingBehavior: options\?\.deliverAs/);
  const start = hostSource.indexOf('// If streaming, queue via steer()');
  const end = hostSource.indexOf('// Flush any pending bash', start);
  assert.ok(start >= 0 && end > start, 'installed prompt streaming branch must remain identifiable');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const accept = new AsyncFunction('options', 'expandedText', 'currentImages',
    `const preflightResult = undefined; ${hostSource.slice(start, end)} return 'normal idle prompt continues';`);
  const queued = [], host = { isStreaming: true,
    _queueSteer: async text => { queued.push(text); },
    _queueFollowUp: async () => assert.fail('must not switch to follow-up delivery') };
  await assert.rejects(accept.call(host, undefined, 'negative control'), /Agent is already processing/);
  const a = await adapter(t); await a.start();
  const submissions = [];
  let busyAtAcceptance = false;
  a.setDelivery((content, options) => {
    // Pi can await input hooks after Intercom samples isIdle; another message can
    // start processing there. Reproduce that change without launching any host.
    submissions.push(Promise.resolve().then(() => {
      host.isStreaming = busyAtAcceptance;
      return accept.call(host, { streamingBehavior: options?.deliverAs }, content);
    }).then(value => ({ value }), error => ({ error })));
  });
  await a.invoke('send', { to: 'Coordinator', message: 'Idle normal prompt' });
  assert.deepEqual(await submissions[0], { value: 'normal idle prompt continues' });
  assert.equal(queued.length, 0, 'explicit steering does not queue when host is idle');
  // ctx.isIdle remains true: the runtime snapshot is deliberately stale.
  busyAtAcceptance = true;
  await a.invoke('send', { to: 'Coordinator', message: 'Race-safe incoming prompt' });
  assert.equal((await submissions[1]).error, undefined);
  assert.equal(queued.length, 1); assert.match(queued[0], /Race-safe incoming prompt/);
});

test('adapter anonymous configure/reload loads responsibility without a work turn; name errors remain explicit', supportedHost, async t => {
  const a = await adapter(t), registrations = [];
  const coordinator = await listen(undefined, async message => { registrations.push(message); });
  t.after(() => coordinator.close());
  const store = new ConfigStore(a.root); await store.initialize('other-coordinator', coordinator.port);
  a.setId('adapter-worker'); await a.start();
  assert.equal(registrations.length, 1); assert.equal(registrations[0].kind, 'registration');
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  const workerPort = registrations[0].payload.port;
  await store.configure('other-coordinator', { sessionId: 'adapter-worker', name: 'Quality', port: workerPort,
    projectDirectory: '.', description: 'Only review explicitly assigned work' });
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  const control = { version: 1, kind: 'reload', from: 'other-coordinator', to: 'adapter-worker', payload: {} };
  a.failName(true);
  await assert.rejects(send(workerPort, control), /injected name failure/);
  assert.equal(a.messages.length, 0);
  assert.match((await a.prompt()).systemPrompt, /Only review explicitly assigned work/);
  // Failed name sync leaves useful endpoint and loaded responsibility intact, with explicit reload recovery.
  a.failName(false); await send(workerPort, control);
  assert.deepEqual(a.names, ['Quality']);
  assert.equal(a.messages.length, 0);
  await send(workerPort, { ...control, kind: 'message', payload: { message: 'Explicit review task' } });
  assert.equal(a.messages.length, 1);
  assert.match(a.messages[0].content, /Explicit review task/);
});

test('adapter activity hooks record snapshots only and coordinator dashboard shuts down with session', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  const notice = a.notices.find(item => item.text.includes('read-only dashboard:'));
  assert.ok(notice);
  const url = notice.text.match(/http:\/\/127\.0\.0\.1:\d+\//)[0];
  assert.equal((await fetch(`${url}api/snapshot`)).status, 200);
  const store = new ConfigStore(a.root), config = await store.read();
  assert.equal(config.agents.find(agent => agent.coordinator).dashboardPort, Number(new URL(url).port));
  const list = JSON.parse((await a.invoke('list')).content[0].text);
  assert.equal(list.dashboardUrl, url);
  a.setIdle(false);
  await a.events.get('agent_start')({ message: 'PRIVATE_EVENT_BODY' }, a.ctx);
  a.setIdle(true);
  await a.events.get('agent_settled')({ message: 'PRIVATE_EVENT_BODY' }, a.ctx);
  assert.equal(a.messages.length, 0, 'activity telemetry must not prompt a worker');
  await a.events.get('session_shutdown')();
  await assert.rejects(fetch(`${url}api/snapshot`));
  const snapshot = await readDashboardSnapshot(a.root);
  const activity = snapshot.events.filter(event => event.event === 'host.activity');
  assert.deepEqual(activity.map(event => [event.outcome, event.busy]), [['started', true], ['settled', false]]);
  assert.doesNotMatch(JSON.stringify(snapshot.events), /PRIVATE_EVENT_BODY|task\.completed/);
});

test('adapter failed dashboard-port persistence closes dashboard without false readiness or lost communication', supportedHost, async t => {
  const a = await adapter(t), bound = [];
  const originalUpdate = ConfigStore.prototype.update, originalListen = Server.prototype.listen;
  ConfigStore.prototype.update = function(id, mutate, guard) {
    return originalUpdate.call(this, id, async config => {
      await mutate(config);
      if (config.agents.some(agent => agent.dashboardPort !== undefined)) throw new Error('injected dashboard persistence failure');
    }, guard);
  };
  Server.prototype.listen = function(...args) {
    this.once('listening', () => { const address = this.address(); if (address && typeof address !== 'string') bound.push(address.port); });
    return originalListen.apply(this, args);
  };
  try { await a.start(); }
  finally { ConfigStore.prototype.update = originalUpdate; Server.prototype.listen = originalListen; }
  assert.equal(bound.length, 2, 'both communication and dashboard bound test-only loopback ports');
  assert.equal(a.notices.some(notice => notice.text.includes('read-only dashboard:')), false);
  assert.ok(a.notices.some(notice => /dashboard port could not be saved/i.test(notice.text)));
  const config = await new ConfigStore(a.root).read();
  assert.equal(config.agents[0].dashboardPort, undefined);
  const dashboardPort = bound.find(port => port !== config.agents[0].port);
  await assert.rejects(fetch(`http://127.0.0.1:${dashboardPort}/api/snapshot`));
  await a.invoke('send', { to: 'Coordinator', message: 'Messaging survives dashboard persistence failure' });
  assert.equal(a.messages.length, 1);
});

test('adapter dashboard bind failure preserves legacy config and communication without claiming a URL', supportedHost, async t => {
  const a = await adapter(t), originalListen = Server.prototype.listen;
  let listens = 0;
  Server.prototype.listen = function(...args) {
    if (++listens === 2) throw Object.assign(new Error('injected dashboard bind failure'), { code: 'EACCES' });
    return originalListen.apply(this, args);
  };
  try { await a.start(); } finally { Server.prototype.listen = originalListen; }
  assert.equal(listens, 2);
  assert.equal(a.notices.some(notice => notice.text.includes('read-only dashboard:')), false);
  assert.equal((await new ConfigStore(a.root).read()).agents[0].dashboardPort, undefined);
  await a.invoke('send', { to: 'Coordinator', message: 'Messaging survives dashboard bind failure' });
  assert.equal(a.messages.length, 1);
});

test('adapter shutdown during pending dashboard-port persistence cannot publish readiness or leave dashboard listening', supportedHost, async t => {
  const a = await adapter(t), bound = [];
  const originalUpdate = ConfigStore.prototype.update, originalListen = Server.prototype.listen;
  let entered, release;
  const pendingWrite = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  ConfigStore.prototype.update = function(id, mutate, guard) {
    return originalUpdate.call(this, id, async config => {
      await mutate(config);
      if (config.agents.some(agent => agent.dashboardPort !== undefined)) { entered(); await gate; }
    }, guard);
  };
  Server.prototype.listen = function(...args) {
    this.once('listening', () => { const address = this.address(); if (address && typeof address !== 'string') bound.push(address.port); });
    return originalListen.apply(this, args);
  };
  let starting;
  try {
    starting = a.start();
    // If startup fails before reaching persistence, fail instead of waiting forever.
    await Promise.race([pendingWrite, starting.then(() => { throw new Error('startup ended before dashboard save'); })]);
    await a.events.get('session_shutdown')();
    release(); await starting;
  } finally {
    release();
    ConfigStore.prototype.update = originalUpdate; Server.prototype.listen = originalListen;
    await starting;
  }
  assert.equal(bound.length, 2);
  assert.equal(a.notices.some(notice => notice.text.includes('read-only dashboard:')), false);
  const saved = JSON.parse(await readFile(new ConfigStore(a.root).file, 'utf8'));
  assert.equal(saved.agents[0].dashboardPort, undefined);
  for (const port of bound) await assert.rejects(fetch(`http://127.0.0.1:${port}/api/snapshot`));
  await assert.rejects(a.invoke('list'), /not initialized/);
});

test('adapter name-sync startup failure retains endpoint, malformed config startup reports failure', supportedHost, async t => {
  const a = await adapter(t); a.failName(true); await a.start();
  assert.ok(a.notices.some(n => /Name\/responsibility synchronization failed/.test(n.text)));
  assert.equal(a.messages.length, 0);
  await a.invoke('list');
  await a.invoke('send', { to: 'Coordinator', message: 'Endpoint retained' });
  assert.equal(a.messages.length, 1);
  await a.events.get('session_shutdown')();
  const store = new ConfigStore(a.root); await writeFile(store.file, '{broken');
  await a.start();
  assert.ok(a.notices.some(n => n.level === 'error'));
  await assert.rejects(a.invoke('list'), /not initialized/);
});
