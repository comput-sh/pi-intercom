import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { INTERCOM_VERSION } from '../dist/version.js';

test('monitor version matches its own package', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(INTERCOM_VERSION, manifest.version);
});

test('version label is validated, package-relative and captured once per process import', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(new URL('../dist/version.js', import.meta.url), 'utf8');
  for (const [i, version] of ['9.8.7-preview.1+test', '\x1b[31munsafe', '', 123, 'x'.repeat(100)].entries()) {
    const fixture = path.join(root, String(i));
    await mkdir(path.join(fixture, 'dist'), {recursive:true});
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({version}));
    const file = path.join(fixture, 'dist', 'version.mjs');
    await writeFile(file, source);
    const label = await import(pathToFileURL(file).href);
    assert.equal(label.INTERCOM_VERSION, i === 0 ? version : 'unknown');
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({version:'1.0.0'}));
    assert.equal((await import(pathToFileURL(file).href)).INTERCOM_VERSION, label.INTERCOM_VERSION);
  }
});
