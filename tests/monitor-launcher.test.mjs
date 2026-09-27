import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureMonitorPane } from '../dist/monitor-launcher.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intercom-monitor-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'monitor.js'); await writeFile(script, '');
  const caller = { pane_id: 'w:p1', tab_id: 'w:t1', workspace_id: 'w' };
  const monitor = { pane_id: 'w:p2', tab_id: 'w:t1', label: 'Intercom monitor [coordinator]' };
  const calls = [], panes = [caller];
  let failAt;
  const options = { root, script, sessionId: 'coordinator', platform: 'linux', env: { HERDR_ENV: '1', HERDR_PANE_ID: 'old:pane' },
    run: async (file, args) => {
      calls.push(args); assert.equal(file, 'herdr');
      if (args[1] === failAt) throw new Error('injected failure');
      let result;
      switch (args[1]) {
        case 'current': result = { pane: caller }; break;
        case 'list': result = { panes }; break;
        case 'split': panes.push({ ...monitor, label: undefined }); result = { pane: monitor }; break;
        case 'rename': panes[1].label = args[3]; result = {}; break;
        case 'swap': result = { swap: { changed: true } }; break;
        case 'layout': result = { layout: { focused_pane_id: caller.pane_id, panes: [
          { pane_id: monitor.pane_id, rect: { y: 0, height: 10 } }, { pane_id: caller.pane_id, rect: { y: 11, height: 30 } },
        ] } }; break;
        case 'run': return '';
        default: assert.fail(args.join(' '));
      }
      return JSON.stringify({ result });
    },
  };
  return { options, calls, panes, monitor, fail: value => { failAt = value; } };
}

test('monitor creation uses live caller IDs, no-focus, verified swap, quoted Node command and reload reuses pane', async t => {
  const f = await fixture(t);
  const result = await ensureMonitorPane(f.options);
  assert.equal(result.pane, 'w:p2');
  assert.deepEqual(f.calls.find(a => a[1] === 'rename'), ['pane', 'rename', 'w:p2', 'Intercom monitor']);
  const split = f.calls.find(a => a[1] === 'split');
  assert.deepEqual(split.slice(0, 6), ['pane', 'split', '--pane', 'w:p1', '--direction', 'down']);
  assert.ok(split.includes('--no-focus'));
  assert.deepEqual(f.calls.find(a => a[1] === 'swap'), ['pane', 'swap', '--source-pane', 'w:p1', '--target-pane', 'w:p2']);
  assert.match(f.calls.find(a => a[1] === 'run')[3], /sh -c/);
  const before = f.calls.length;
  assert.match((await ensureMonitorPane(f.options)).outcome, /existing pane preserved/);
  assert.deepEqual(f.calls.slice(before).map(a => a[1]), ['current', 'list']);
});
test('missing marked pane after confirmed submission creates replacement; unrelated panes stay untouched', async t => {
  const f = await fixture(t); await ensureMonitorPane(f.options);
  f.panes.splice(1, 1);
  await ensureMonitorPane(f.options);
  assert.equal(f.calls.filter(a => a[1] === 'split').length, 2);
  assert.equal(f.calls.some(a => a[1] === 'close'), false);
});
test('uncertain split and unmarked partial launch are fenced across retry', async t => {
  for (const stage of ['split', 'rename']) {
    const f = await fixture(t); f.fail(stage);
    await assert.rejects(ensureMonitorPane(f.options), /no automatic cleanup/);
    const before = f.calls.length; f.fail(undefined);
    await assert.rejects(ensureMonitorPane(f.options), /no retry or duplicate/);
    assert.deepEqual(f.calls.slice(before).map(a => a[1]), ['current', 'list']);
  }
});
test('existing moved or duplicate markers fail without mutation', async t => {
  const f = await fixture(t);
  f.panes.push({ ...f.monitor, tab_id: 'other-tab' });
  await assert.rejects(ensureMonitorPane(f.options), /another tab/);
  f.panes.push({ ...f.monitor, pane_id: 'w:p3' });
  await assert.rejects(ensureMonitorPane(f.options), /Multiple monitor markers/);
  assert.equal(f.calls.some(a => a[1] === 'split'), false);
});
test('non-Herdr skips, missing compiled entry and stale owner reject before splitting', async t => {
  const f = await fixture(t);
  assert.match((await ensureMonitorPane({ ...f.options, env: {} })).outcome, /not inside Herdr/);
  await assert.rejects(ensureMonitorPane({ ...f.options, script: path.join(f.options.root, 'missing.js') }), /ENOENT/);
  await assert.rejects(ensureMonitorPane({ ...f.options, assertCurrent: () => { throw new Error('stale owner'); } }), /stale owner/);
  assert.equal(f.calls.some(a => a[1] === 'split'), false);
});
test('legacy label migrates to simple name and saved identity prevents duplicate creation', async t => {
  const f = await fixture(t);
  f.panes.push({ ...f.monitor });
  await ensureMonitorPane(f.options);
  assert.equal(f.panes[1].label, 'Intercom monitor');
  await ensureMonitorPane(f.options);
  assert.equal(f.calls.filter(a => a[1] === 'rename').length, 1);
  assert.equal(f.calls.some(a => a[1] === 'split' || a[1] === 'run'), false);
});
test('generic label alone is not ownership', async t => {
  const f = await fixture(t);
  f.panes.push({ ...f.monitor, label: 'Intercom monitor' });
  await assert.rejects(ensureMonitorPane(f.options), /Unowned monitor label/);
  assert.equal(f.calls.some(a => a[1] === 'split' || a[1] === 'rename'), false);
});

test('Windows monitor command uses encoded PowerShell and explicit Node executable', async t => {
  const f = await fixture(t);
  await ensureMonitorPane({ ...f.options, platform: 'win32', node: "C:/Node O'Brien/node.exe" });
  const command = f.calls.find(a => a[1] === 'run')[3];
  assert.match(command, /^powershell.exe /);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /C:\/Node O''Brien\/node.exe/);
  assert.match(script, /'--root'/);
});
