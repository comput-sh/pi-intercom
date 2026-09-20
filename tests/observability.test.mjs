import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile, utimes, truncate } from 'node:fs/promises';
import { LocalObserver, sanitizeObservation, observationError, LOG_DIRECTORY, LOG_FILE_PATTERN, LOG_LIMITS } from '../dist/observability.js';
import { envelope } from '../dist/transport.js';
import { Intercom } from '../dist/runtime.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function contents(root) {
  const directory = path.join(root, LOG_DIRECTORY);
  const names = (await readdir(directory)).filter(name => LOG_FILE_PATTERN.test(name));
  return { names, text: (await Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8')))).join('') };
}
test('writer emits allowlisted metadata only and marks graceful close without changing session identity', async t => {
  const root = await fixture(t), observer = new LocalObserver(root, 'session-a');
  observer.record('host.submission', { outcome: 'attempted', peerSessionId: 'peer', peerName: 'Builder', correlationId: 'corr-1', busy: true,
    message: 'PRIVATE_MESSAGE', description: 'PRIVATE_RESPONSIBILITY', headers: { token: 'PRIVATE_TOKEN' }, error: 'PRIVATE_ERROR', errorCode: 'PRIVATE_ERROR_CODE' });
  await observer.close();
  const { names, text } = await contents(root);
  assert.equal(names.length, 1); assert.match(names[0], /\.closed$/);
  for (const secret of ['PRIVATE_MESSAGE', 'PRIVATE_RESPONSIBILITY', 'PRIVATE_TOKEN', 'PRIVATE_ERROR']) assert.equal(text.includes(secret), false);
  const event = JSON.parse(text);
  assert.equal(event.sessionId, 'session-a'); assert.equal(event.writerId, observer.writerId);
  assert.equal(event.correlationId, 'corr-1'); assert.equal(event.outcome, 'attempted');
  assert.equal(event.errorCode, undefined); assert.equal(event.instanceId, undefined);
  assert.equal(observationError(new Error('PRIVATE_ERROR')), 'operation_failed');
  assert.equal(observationError({ code: 'ECONNREFUSED', message: 'PRIVATE_ERROR' }), 'ECONNREFUSED');
  assert.equal(observationError({ get code() { throw new Error('PRIVATE_ERROR'); } }), 'operation_failed');
});
test('sanitizer projects disk input and refuses unknown events and unbounded identities', () => {
  const valid = { version: 1, timestamp: new Date().toISOString(), writerId: randomUUID(), sessionId: 's', event: 'runtime.ready' };
  assert.equal(sanitizeObservation({ ...valid, message: 'secret', errorCode: 'secret', peerName: 'bad\nname' }).message, undefined);
  assert.equal(sanitizeObservation({ ...valid, event: 'secret' }), undefined);
  assert.equal(sanitizeObservation({ ...valid, sessionId: 'x'.repeat(257) }), undefined);
  assert.equal(sanitizeObservation({ ...valid, writerId: 'not-a-uuid' }), undefined);
  assert.equal(sanitizeObservation({ ...valid, outcome: 'model_completed', correlationId: 'bad token' }).outcome, undefined);
});
test('separate writer files and bounded rotation retain only three files per writer', async t => {
  const root = await fixture(t), first = new LocalObserver(root, 'same-session', { fileBytes: 4096 });
  const second = new LocalObserver(root, 'same-session', { fileBytes: 4096 });
  for (let i = 0; i < 200; i++) first.record('transport.send', { peerName: 'x'.repeat(128), correlationId: `message-${i}`, outcome: 'attempted' });
  second.record('runtime.ready', { busy: false });
  await Promise.all([first.close(), second.close()]);
  const { names, text } = await contents(root);
  assert.equal(names.filter(name => name.includes(first.writerId)).length, 3);
  assert.equal(names.filter(name => name.includes(second.writerId)).length, 1);
  for (const name of names) assert.ok((await stat(path.join(root, LOG_DIRECTORY, name))).size <= 4096);
  for (const line of text.trim().split('\n')) assert.ok(sanitizeObservation(JSON.parse(line)));
});
test('slow writer uses a bounded queue and never waits in record', async t => {
  const root = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  class SlowObserver extends LocalObserver {
    async append(file, line) { entered(); await gate; return super.append(file, line); }
  }
  const observer = new SlowObserver(root, 'session', { queueEntries: 2 });
  observer.record('runtime.starting'); await started;
  for (let i = 0; i < 8; i++) assert.equal(observer.record('host.activity', { busy: true }), undefined);
  assert.equal(observer.dropped, 6);
  release(); await observer.close();
  assert.equal((await contents(root)).text.trim().split('\n').length, 3);
});
test('logging I/O failure disables only its writer, does not leak errors or retry', async t => {
  const root = await fixture(t);
  let attempts = 0;
  class FailedObserver extends LocalObserver {
    async append() { attempts++; throw new Error('SECRET_FILESYSTEM_PATH_TOKEN'); }
  }
  const observer = new FailedObserver(root, 'session');
  observer.record('runtime.starting'); await observer.pending;
  observer.record('runtime.ready'); await observer.close();
  assert.equal(attempts, 1);
  assert.equal((await contents(root)).text, '');
});
test('coordinator maintenance prunes only closed writers by age/quota, never active or unrelated files', async t => {
  const root = await fixture(t), directory = path.join(root, LOG_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const inactive = path.join(directory, `writer-${randomUUID()}.jsonl.closed`);
  const active = path.join(directory, `writer-${randomUUID()}.jsonl`);
  const unrelated = path.join(directory, 'unrelated.txt');
  await Promise.all([writeFile(inactive, '{}\n'), writeFile(active, '{}\n'), writeFile(unrelated, 'keep')]);
  const old = new Date(Date.now() - LOG_LIMITS.retentionMs - 10000);
  await Promise.all([utimes(inactive, old, old), utimes(active, old, old)]);
  // A worker writer does not perform directory-wide maintenance.
  const worker = new LocalObserver(root, 'worker'); worker.record('runtime.ready'); await worker.close();
  assert.ok(await stat(inactive));
  const large = path.join(directory, `writer-${randomUUID()}.jsonl.closed`);
  await writeFile(large, ''); await truncate(large, LOG_LIMITS.directoryBytes + 1);
  const coordinator = new LocalObserver(root, 'coordinator'); coordinator.maintain(); coordinator.record('runtime.ready'); await coordinator.close();
  await assert.rejects(stat(inactive), { code: 'ENOENT' });
  await assert.rejects(stat(large), { code: 'ENOENT' });
  assert.ok(await stat(active)); assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});
test('runtime shutdown closes transport first, bounds a hung observer, and shares repeated close', async t => {
  const root = await fixture(t);
  let endpointClosed = false, observerCloses = 0;
  const runtime = new Intercom({ cwd: root, sessionId: () => 'coordinator', busy: () => false,
    deliver: () => {}, setName: async () => {}, notify: () => {} }, {
    launch: async () => { throw new Error('not used'); },
    listen: async () => ({ port: 12345, close: async () => { endpointClosed = true; } }),
    observe: () => ({ record: () => {}, close: () => {
      assert.equal(endpointClosed, true); observerCloses++;
      return new Promise(() => {});
    } }),
  });
  await runtime.start();
  const start = performance.now();
  await Promise.all([runtime.close(), runtime.close()]);
  const elapsed = performance.now() - start;
  assert.equal(observerCloses, 1);
  assert.ok(elapsed >= LOG_LIMITS.closeTimeoutMs - 20 && elapsed < 1500, `shutdown elapsed ${elapsed}ms`);
  await runtime.close(); assert.equal(observerCloses, 1);
  await assert.rejects(runtime.tool('list', {}), /inactive/);
});
test('optional correlation IDs preserve legacy envelopes and validate bounded metadata', () => {
  const legacy = { version: 1, kind: 'message', from: 'a', to: 'b', payload: { message: 'hello' } };
  assert.equal(envelope(legacy).correlationId, undefined);
  const correlationId = randomUUID();
  assert.equal(envelope({ ...legacy, correlationId }).correlationId, correlationId);
  for (const value of ['', 'secret\nheader', 'x'.repeat(129), 123]) assert.throws(() => envelope({ ...legacy, correlationId: value }), /correlation/);
});
