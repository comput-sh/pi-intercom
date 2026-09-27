import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../dist/config.js';
import { LocalObserver, LOG_DIRECTORY, LOG_FILE_PATTERN } from '../dist/observability.js';
import { readObservationSnapshot } from '../dist/snapshot.js';

const SECRET = 'UNEXPECTED_SECRET_BODY_OR_CREDENTIAL';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-snapshot-'));
  const store = new ConfigStore(root); await store.initialize('coordinator', 32100);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store };
}
async function sampleObservation(root) {
  const observer = new LocalObserver(root, 'coordinator'); observer.record('host.activity', { outcome: 'snapshot', busy: false });
  await observer.close();
  const directory = path.join(root, LOG_DIRECTORY);
  const names = (await readdir(directory)).filter(name => LOG_FILE_PATTERN.test(name));
  const file = path.join(directory, names[0]);
  const event = JSON.parse((await readFile(file, 'utf8')).trim().split('\n')[0]);
  return { file, event };
}

test('snapshot projects allowed metadata only, rejects partial records, and preserves unknown/stale evidence without completion claims', async t => {
  const f = await fixture(t), { file, event } = await sampleObservation(f.root);
  const config = await f.store.read(); config.token = SECRET; config.agents[0].credentials = SECRET;
  config.agents[0].name = 'Coordinator';
  config.agents[0].description = '<img src=x onerror=alert(1)>';
  await writeFile(f.store.file, JSON.stringify(config));
  const hostile = { ...event, sessionId: 'removed-worker', timestamp: '2020-01-01T00:00:00.000Z', event: 'transport.receipt',
    outcome: 'http_receipt', message: SECRET, payload: { token: SECRET }, stack: SECRET, credentials: SECRET };
  await writeFile(file, JSON.stringify(hostile) + '\n' + JSON.stringify({ ...hostile, event: 'task.completed' }) + '\n' + JSON.stringify(hostile).slice(0, -3));
  const before = await readFile(file, 'utf8');
  const snapshot = await readObservationSnapshot(f.root);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].sessionId, 'removed-worker');
  assert.equal(snapshot.events[0].timestamp, hostile.timestamp);
  assert.equal(snapshot.events[0].outcome, 'http_receipt');
  assert.equal(snapshot.staleAfterMs, 60000);
  assert.equal(snapshot.config.agents.some(agent => agent.sessionId === 'removed-worker'), false);
  assert.equal(snapshot.config.agents[0].description, config.agents[0].description, 'reader preserves literal metadata without interpreting markup');
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(snapshot.events), /completed|healthy|alive/);
  assert.equal(await readFile(file, 'utf8'), before, 'reads must not mutate or repair logs');
});

test('snapshot bounds event/config reads and returns only generic errors for oversized or malformed input', async t => {
  const f = await fixture(t), { file, event } = await sampleObservation(f.root);
  await writeFile(file, Array.from({ length: 1500 }, (_, index) => JSON.stringify({ ...event, correlationId: `event-${index}` })).join('\n') + '\n');
  const snapshot = await readObservationSnapshot(f.root);
  assert.ok(snapshot.events.length <= 500); assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.events.at(-1).correlationId, 'event-1499');
  for (const content of [`{broken-${SECRET}`, ' '.repeat(1024 * 1024 + 1)]) {
    await writeFile(f.store.file, content);
    const result = await readObservationSnapshot(f.root);
    assert.equal(result.config, null); assert.ok(result.errors.includes('config_unavailable'));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  }
});

test('snapshot caps agent and selected-log counts and ignores unrelated files', async t => {
  const f = await fixture(t), { file, event } = await sampleObservation(f.root);
  const config = await f.store.read();
  for (let i = 0; i < 260; i++) config.agents.push({ sessionId: `worker-${i}`, name: `Worker${i}`, coordinator: false,
    description: 'Saved remit', port: 10000 + i, projectDirectory: '.' });
  await writeFile(f.store.file, JSON.stringify(config));
  await rm(file);
  const directory = path.join(f.root, LOG_DIRECTORY);
  for (let i = 0; i < 34; i++) await writeFile(path.join(directory, `writer-${randomUUID()}.jsonl.closed`), JSON.stringify({ ...event, correlationId: `file-${i}` }) + '\n');
  await writeFile(path.join(directory, 'credentials.json'), JSON.stringify({ ...event, sessionId: SECRET }) + '\n');
  const snapshot = await readObservationSnapshot(f.root);
  assert.equal(snapshot.config.agents.length, 256); assert.equal(snapshot.events.length, 32);
  assert.equal(snapshot.truncated, true); assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
});

test('snapshot refuses symlink/junction directory escapes without reading external metadata', async t => {
  const f = await fixture(t), outside = await mkdtemp(path.join(tmpdir(), 'intercom-quality-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { event } = await sampleObservation(outside);
  const externalLogs = path.join(outside, LOG_DIRECTORY);
  for (const name of await readdir(externalLogs)) await writeFile(path.join(externalLogs, name), JSON.stringify({ ...event, sessionId: SECRET }) + '\n');
  await symlink(externalLogs, path.join(f.root, LOG_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await readObservationSnapshot(f.root);
  assert.ok(snapshot.errors.includes('logs_unavailable')); assert.equal(snapshot.events.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
});
