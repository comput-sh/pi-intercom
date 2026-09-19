import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, directory, named, validateConfig } from '../dist/config.js';
import { listen, send, envelope, BODY_LIMIT } from '../dist/transport.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new ConfigStore(root);
}
const worker = (id = 'worker', name = 'Builder') => ({ sessionId: id, name, port: 12345, description: 'Build only assigned work', projectDirectory: '.' });
test('atomic first creation publishes complete config: exactly one winner', async t => {
  const s = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => new ConfigStore(s.root).initialize(`session-${i}`, 12345)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await s.read()).agents.length, 1);
});
test('upward discovery, descendant validation and invalid config preservation', async t => {
  const s = await fixture(t); await s.initialize('coordinator', 12345);
  const child = path.join(s.root, 'a', 'b'); await mkdir(child, { recursive: true });
  assert.equal((await ConfigStore.discover(child)).root, s.root);
  assert.equal(await directory(s.root, child), 'a/b');
  await assert.rejects(directory(s.root, '..'), /descendant/);
  await writeFile(s.file, '{broken');
  await assert.rejects(ConfigStore.discover(child));
  await assert.rejects(s.update('coordinator', c => c.agents.pop()));
  assert.equal(await readFile(s.file, 'utf8'), '{broken');
});
test('coordinator writes only, unique case-insensitive names, serialized writes', async t => {
  const s = await fixture(t); await s.initialize('coordinator', 12345);
  await assert.rejects(s.configure('unknown', worker()), /permission/);
  await s.configure('coordinator', worker());
  assert.equal(named(await s.read(), 'bUiLdEr').name, 'Builder');
  await assert.rejects(s.configure('coordinator', worker('other', 'builder')), /duplicate/);
  await assert.rejects(s.configure('coordinator', worker('other', 'COORDINATOR')), /duplicate|reserved/);
  await s.configure('coordinator', worker());
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.configure('coordinator', worker(`w${i}`, `Worker${i}`))));
  assert.equal((await s.read()).agents.length, 22);
  await assert.rejects(s.configure('coordinator', worker('coordinator')), /coordinator/);
});
test('schema rejects malformed version, port, duplicate IDs, traversal', async t => {
  const s = await fixture(t); await s.initialize('c', 12345);
  const c = await s.read();
  for (const patch of [{ version: 2 }, { multiplexer: 'tmux' }, { agents: [] }]) assert.throws(() => validateConfig({ ...c, ...patch }));
  for (const patch of [{ port: 0 }, { projectDirectory: '../elsewhere' }, { name: 'bad\nname' }]) {
    assert.throws(() => validateConfig({ ...c, agents: [...c.agents, { ...worker(), coordinator: false, ...patch }] }));
  }
  assert.throws(() => envelope({ version: 1, kind: 'status', from: 'w', to: 'c', payload: { port: 1, busy: 'yes' } }));
});
test('loopback receipt, port fallback, rejection, body bound and no retry', async t => {
  let received = 0;
  const a = await listen(undefined, async m => { received++; if (m.to !== 'a') throw new Error('recipient mismatch'); });
  const b = await listen(a.port, async () => {});
  t.after(async () => { await a.close(); await b.close(); });
  assert.notEqual(a.port, b.port);
  const m = { version: 1, kind: 'message', from: 'b', to: 'a', payload: { message: 'hello' } };
  await send(a.port, m); assert.equal(received, 1);
  await assert.rejects(send(a.port, { ...m, to: 'wrong' }), /recipient mismatch/);
  assert.equal(received, 2);
  await assert.rejects(send(a.port, { ...m, payload: { message: 'a'.repeat(BODY_LIMIT) } }));
  const res = await fetch(`http://127.0.0.1:${a.port}/intercom`, { method: 'POST', body: 'x'.repeat(BODY_LIMIT + 1) });
  assert.equal(res.status, 413);
  assert.equal(received, 2);
});
test('receipt deadline bounds a stalled receiver and never retries', async t => {
  let count = 0;
  const a = await listen(undefined, async () => { count++; await new Promise(() => {}); });
  t.after(() => a.close());
  await assert.rejects(send(a.port, { version: 1, kind: 'reload', from: 'c', to: 'w', payload: {} }, 30), /timeout/);
  assert.equal(count, 1);
});
