import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../dist/index.js';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../dist/config.js';
import { listen, send } from '../dist/transport.js';

// These exercise the real Windows-only adapter, but never construct a Pi host or launch a process.
async function adapter(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-adapter-'));
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
    await events.get('session_shutdown')();
    if (inheritedHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = inheritedHerdr;
    await rm(root, { recursive: true, force: true });
  });
  return { root, ctx, tools, events, messages, notices, names,
    setId: value => { id = value; }, setIdle: value => { idle = value; }, failName: value => { failName = value; },
    start: () => events.get('session_start')({}, ctx),
    prompt: () => events.get('before_agent_start')({ systemPrompt: 'Original system prompt' }, ctx),
    invoke: (operation, args = {}) => tools.get(`intercom_${operation}`).execute('test', args, undefined, undefined, ctx) };
}
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows-only extension startup adapter' : false };

test('single extension registers all agreed tools without starting resources in factory', async () => {
  const tools = new Map(), events = new Map();
  extension({ registerTool: t => tools.set(t.name, t), on: (name, handler) => events.set(name, handler) });
  assert.equal(tools.size, 12);
  assert.deepEqual([...events.keys()], ['session_start', 'session_shutdown', 'before_agent_start']);
  const configure = tools.get('intercom_configure_worker');
  assert.deepEqual([...configure.parameters.required].sort(), ['description', 'name', 'port', 'projectDirectory', 'sessionId']);
  assert.match(tools.get('intercom_stop_worker').description, /disabled/);
  assert.match(tools.get('intercom_reload_worker').description, /NOT Pi extension reload/);
  await assert.rejects(tools.get('intercom_list').execute('test', {}, undefined, undefined, {}), /not initialized/);
  await events.get('session_shutdown')();
  await events.get('session_shutdown')();
});

test('adapter rejects untrusted/noninteractive startup before creating config', windowsOnly, async t => {
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

test('adapter startup is passive, adds responsibility, routes idle/steering and replaces session listener', windowsOnly, async t => {
  const a = await adapter(t); await a.start();
  assert.equal(a.messages.length, 0);
  assert.deepEqual(a.names, ['Coordinator']);
  const prompt = await a.prompt();
  assert.match(prompt.systemPrompt, /^Original system prompt/);
  assert.match(prompt.systemPrompt, /Identity: Coordinator \(adapter-coordinator\)/);
  assert.match(prompt.systemPrompt, /Responsibility is not a work assignment/);
  const store = new ConfigStore(a.root), old = (await store.read()).agents[0];
  await a.invoke('send', { to: 'Coordinator', message: 'Idle message' });
  assert.equal(a.messages.at(-1).options, undefined);
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

test('adapter anonymous configure/reload loads responsibility without a work turn; name errors remain explicit', windowsOnly, async t => {
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

test('adapter name-sync startup failure retains endpoint, malformed config startup reports failure', windowsOnly, async t => {
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
