import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readObservationSnapshot } from '../dist/snapshot.js';

const writerId = '01900000-0000-7000-8000-000000000001';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-snapshot-'));
  const logs = path.join(root, '.pi-intercom', 'logs');
  await mkdir(logs, { recursive: true });
  const config = { version: 1, multiplexer: 'herdr', ignoredSecret: 'NEVER_RETURN', agents: [{
    sessionId: 'coordinator', name: 'Coordinator', description: 'Coordinate work', coordinator: true,
    projectDirectory: '.', port: 34567, dashboardPort: 34568, ignoredSecret: 'NEVER_RETURN',
  }] };
  const configFile = path.join(root, '.pi-intercom', 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, logs, configFile };
}
const event = (timestamp, busy = false) => ({ version: 1, writerId, sessionId: 'coordinator', timestamp,
  event: 'host.activity', busy, outcome: busy ? 'started' : 'settled' });

test('snapshot projects allowlisted config and ordered log metadata without raw bodies', async t => {
  const f = await fixture(t);
  const first = event('2026-01-01T00:00:00.000Z', true), last = event('2026-01-01T00:00:01.000Z');
  await writeFile(path.join(f.logs, `writer-${writerId}.jsonl`), [
    JSON.stringify({ ...last, message: 'NEVER_RETURN', error: 'NEVER_RETURN' }),
    'not JSON', JSON.stringify(first), '{"incomplete":',
  ].join('\n'));
  const snapshot = await readObservationSnapshot(f.root);
  assert.equal(snapshot.staleAfterMs, 60000);
  assert.deepEqual(snapshot.events, [first, last]);
  assert.equal(snapshot.config.agents[0].name, 'Coordinator');
  assert.equal(snapshot.config.agents[0].dashboardPort, undefined, 'retired browser metadata is not projected');
  assert.doesNotMatch(JSON.stringify(snapshot), /NEVER_RETURN/);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.truncated, false);
});

test('snapshot is bounded, marks discarded older observations, and never rewrites files', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 700 }, (_, i) => event(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
  const logFile = path.join(f.logs, `writer-${writerId}.jsonl`);
  const content = records.map(x => JSON.stringify(x)).join('\n') + '\n';
  await writeFile(logFile, content);
  const before = await readFile(f.configFile, 'utf8');
  const snapshot = await readObservationSnapshot(f.root);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.events.length <= 500);
  assert.deepEqual(snapshot.events.at(-1), records.at(-1));
  assert.equal(await readFile(logFile, 'utf8'), content);
  assert.equal(await readFile(f.configFile, 'utf8'), before);
});
