import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveWorkerReport, readWorkerReports } from '../dist/reports.js';
const report = (sessionId = 'worker', status = 'blocked', summary = 'Awaiting a public decision.') => ({
  version: 1, sessionId, status, summary, updatedAt: '2026-01-01T00:00:00.000Z',
});
const directory = root => path.join(root, '.pi-intercom', 'reports');
const file = (root, id) => path.join(directory(root), `${createHash('sha256').update(id).digest('hex')}.json`);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-reports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reports round-trip fixed public fields, hash IDs, replace atomically, and clear with a tombstone', async t => {
  const root = await fixture(t), id = '../../untrusted-name';
  for (const status of ['blocked', 'needs_decision', 'ready_for_review']) {
    const value = report(id, status);
    await saveWorkerReport(root, { ...value, ignoredPrivate: 'NOT_PERSISTED' });
    assert.deepEqual(await readWorkerReports(root, [id]), [value]);
    const content = await readFile(file(root, id), 'utf8');
    assert.doesNotMatch(content, /NOT_PERSISTED/);
    if (process.platform !== 'win32') assert.equal((await stat(file(root, id))).mode & 0o777, 0o600);
  }
  const cleared = report(id, 'clear', '');
  await saveWorkerReport(root, cleared);
  assert.deepEqual(await readWorkerReports(root, [id]), [cleared]);
  assert.deepEqual(await readdir(directory(root)), [path.basename(file(root, id))]);
});

test('save rejects malformed fields with generic errors and no filesystem creation', async t => {
  const root = await fixture(t);
  for (const value of [
    { ...report(), version: 2 }, { ...report(), sessionId: '' }, { ...report(), sessionId: 'a'.repeat(257) },
    { ...report(), sessionId: 'unsafe\n' }, { ...report(), status: 'approved' },
    { ...report(), summary: '' }, { ...report(), summary: ' \n\t' }, { ...report(), summary: 'a'.repeat(2001) },
    { ...report(), summary: '\x1b]52;private\x07' }, report('w', 'clear', 'nonempty'),
    { ...report(), updatedAt: 'not-a-date' }, { ...report(), updatedAt: '2026-02-30T00:00:00.000Z' },
  ]) {
    await assert.rejects(saveWorkerReport(root, value), { message: 'Worker report could not be saved.' });
  }
  assert.deepEqual(await readdir(root), []);
  await saveWorkerReport(root, report('valid', 'blocked', 'a'.repeat(2000)));
  assert.equal((await readWorkerReports(root, ['valid']))[0].summary.length, 2000);
});

test('reads only requested IDs, bounded to first256, deduplicates, and never repairs malformed data', async t => {
  const root = await fixture(t);
  await saveWorkerReport(root, report('allowed'));
  await saveWorkerReport(root, report('later'));
  assert.deepEqual(await readWorkerReports(root, ['missing', 'allowed', 'allowed']), [report('allowed')]);
  assert.deepEqual(await readWorkerReports(root, [...Array.from({ length: 256 }, (_, i) => `missing-${i}`), 'later']), []);
  const target = file(root, 'allowed');
  for (const content of ['{PRIVATE_BROKEN', 'x'.repeat(8193), JSON.stringify(report('different')), JSON.stringify({ ...report('allowed'), status: 'completed' })]) {
    await writeFile(target, content);
    assert.deepEqual(await readWorkerReports(root, ['allowed']), []);
    assert.equal(await readFile(target, 'utf8'), content);
  }
});

test('missing report directories read as unavailable without creating state', async t => {
  const root = await fixture(t);
  assert.deepEqual(await readWorkerReports(root, ['worker']), []);
  assert.deepEqual(await readdir(root), []);
});

test('symlink directory components are refused for save and read', async t => {
  for (const component of ['.pi-intercom', 'reports']) {
    const root = await fixture(t), outside = await fixture(t);
    if (component === 'reports') await mkdir(path.join(root, '.pi-intercom'));
    const target = component === 'reports' ? directory(root) : path.join(root, '.pi-intercom');
    await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(saveWorkerReport(root, report()), { message: 'Worker report could not be saved.' });
    assert.deepEqual(await readWorkerReports(root, ['worker']), []);
    assert.deepEqual(await readdir(outside), []);
  }
});

test('symlink report files never expose or overwrite their target', { skip: process.platform === 'win32' ? 'file symlinks require elevated Windows privileges' : false }, async t => {
  const root = await fixture(t), outside = await fixture(t);
  const external = path.join(outside, 'private.json'), content = JSON.stringify(report());
  await writeFile(external, content);
  await mkdir(directory(root), { recursive: true });
  await symlink(external, file(root, 'worker'));
  assert.deepEqual(await readWorkerReports(root, ['worker']), []);
  await assert.rejects(saveWorkerReport(root, report('worker', 'clear', '')), { message: 'Worker report could not be saved.' });
  assert.equal(await readFile(external, 'utf8'), content);
});

test('report nonfiles are skipped and cannot be overwritten', async t => {
  const root = await fixture(t);
  await mkdir(file(root, 'worker'), { recursive: true });
  assert.deepEqual(await readWorkerReports(root, ['worker']), []);
  await assert.rejects(saveWorkerReport(root, report()), { message: 'Worker report could not be saved.' });
  assert.equal((await stat(file(root, 'worker'))).isDirectory(), true);
});

test('lifecycle guard fences publication and cleans only its unpublished temp file', async t => {
  const root = await fixture(t), original = report();
  await saveWorkerReport(root, original);
  let calls = 0;
  await assert.rejects(saveWorkerReport(root, report('worker', 'clear', ''), () => {
    // Initial check, two directory checks, temp open, temp write, final rename.
    if (++calls === 6) throw new Error('PRIVATE_GUARD_ERROR');
  }), { message: 'Worker report could not be saved.' });
  assert.equal(calls, 6);
  assert.deepEqual(await readWorkerReports(root, ['worker']), [original]);
  assert.deepEqual(await readdir(directory(root)), [path.basename(file(root, 'worker'))]);
  const untouched = await fixture(t);
  await assert.rejects(saveWorkerReport(untouched, report(), () => { throw new Error('obsolete'); }));
  assert.deepEqual(await readdir(untouched), []);
});
