import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../dist/config.js';
import { LocalObserver, LOG_DIRECTORY, LOG_FILE_PATTERN } from '../dist/observability.js';
import { startDashboard, readDashboardSnapshot } from '../dist/dashboard.js';

const SECRET = 'UNEXPECTED_SECRET_BODY_OR_CREDENTIAL';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-dashboard-'));
  const assets = path.join(root, 'assets'); await mkdir(assets);
  await Promise.all(['index.html', 'app.js', 'style.css'].map(name => writeFile(path.join(assets, name), `fixed asset ${name}`)));
  const store = new ConfigStore(root); await store.initialize('coordinator', 32100);
  const servers = [];
  t.after(async () => { for (const server of servers) await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, assets, store, start: async () => { const server = await startDashboard(root, { assetDirectory: assets }); servers.push(server); return server; } };
}
function request(server, route = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.port, path: route, method: options.method ?? 'GET',
      headers: { Host: `127.0.0.1:${server.port}`, ...options.headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
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

test('dashboard HTTP surface is fixed-path GET-only, same-origin loopback with security headers', async t => {
  const f = await fixture(t), server = await f.start();
  assert.equal(new URL(server.url).hostname, '127.0.0.1');
  for (const route of ['/', '/app.js', '/style.css', '/api/snapshot']) {
    const response = await request(server, route); assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
  }
  for (const route of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/.pi-intercom/config.json', '/api/snapshot?file=../secret', '/api/snapshot/', '/__proto__', '/constructor', '/app.js?x=1']) {
    assert.equal((await request(server, route)).status, 404, route);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const response = await request(server, '/api/snapshot', { method }); assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET');
  }
  for (const headers of [{ Host: 'attacker.example' }, { Host: `127.0.0.1:${server.port + 1}` },
    { Origin: 'https://attacker.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(server, '/api/snapshot', { headers })).status, 403);
  }
  assert.equal((await request(server, '/api/snapshot', { headers: { Origin: `http://127.0.0.1:${server.port}` } })).status, 200);
  await server.close(); await server.close();
  await assert.rejects(request(server), /ECONNREFUSED|ECONNRESET/);
});

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
  const snapshot = await readDashboardSnapshot(f.root);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].sessionId, 'removed-worker');
  assert.equal(snapshot.events[0].timestamp, hostile.timestamp);
  assert.equal(snapshot.events[0].outcome, 'http_receipt');
  assert.equal(snapshot.staleAfterMs, 60000);
  assert.equal(snapshot.config.agents.some(agent => agent.sessionId === 'removed-worker'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(snapshot.events), /completed|healthy|alive/);
  assert.equal(await readFile(file, 'utf8'), before, 'reads must not mutate or repair logs');
  const server = await f.start(), response = await request(server, '/api/snapshot');
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(JSON.parse(response.body).config.agents[0].description, config.agents[0].description);
  assert.doesNotMatch((await request(server)).body, /onerror=/, 'project fields are never interpolated into served HTML');
});

test('snapshot bounds event/config reads and returns only generic errors for oversized or malformed input', async t => {
  const f = await fixture(t), { file, event } = await sampleObservation(f.root);
  await writeFile(file, Array.from({ length: 1500 }, (_, index) => JSON.stringify({ ...event, correlationId: `event-${index}` })).join('\n') + '\n');
  const snapshot = await readDashboardSnapshot(f.root);
  assert.ok(snapshot.events.length <= 500); assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.events.at(-1).correlationId, 'event-1499');
  for (const content of [`{broken-${SECRET}`, ' '.repeat(1024 * 1024 + 1)]) {
    await writeFile(f.store.file, content);
    const result = await readDashboardSnapshot(f.root);
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
  const snapshot = await readDashboardSnapshot(f.root);
  assert.equal(snapshot.config.agents.length, 256); assert.equal(snapshot.events.length, 32);
  assert.equal(snapshot.truncated, true); assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
});

test('dashboard refuses symlink/junction directory escapes without reading external metadata', async t => {
  const f = await fixture(t), outside = await mkdtemp(path.join(tmpdir(), 'intercom-quality-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { event } = await sampleObservation(outside);
  const externalLogs = path.join(outside, LOG_DIRECTORY);
  for (const name of await readdir(externalLogs)) await writeFile(path.join(externalLogs, name), JSON.stringify({ ...event, sessionId: SECRET }) + '\n');
  await symlink(externalLogs, path.join(f.root, LOG_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await readDashboardSnapshot(f.root);
  assert.ok(snapshot.errors.includes('logs_unavailable')); assert.equal(snapshot.events.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SECRET));
});

test('dashboard UI renders hostile project metadata as text and labels stale/unknown evidence without task completion', async () => {
  const elements = new Map(), created = [], requests = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.value = ''; this.textContent = ''; created.push(this); }
    set innerHTML(_value) { assert.fail('UI must not render metadata as HTML'); }
    set outerHTML(_value) { assert.fail('UI must not render metadata as HTML'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener() {}
    querySelectorAll() { return []; }
  }
  const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); },
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    querySelector: () => new Element('form'), activeElement: null };
  const hostile = '<img src=x onerror="throw SECRET">';
  const snapshot = { version: 1, generatedAt: new Date().toISOString(), staleAfterMs: 60000, errors: [], truncated: false,
    config: { agents: [ { sessionId: 'old', name: hostile, description: hostile, port: 1234 }, { sessionId: 'unknown', name: 'Unknown worker' } ] },
    events: [{ sessionId: 'old', event: 'host.activity', timestamp: '2020-01-01T00:00:00.000Z', busy: true },
      { sessionId: 'old', peerName: hostile, event: 'transport.receipt', outcome: 'http_receipt', timestamp: '2020-01-01T00:00:01.000Z' }] };
  const context = vm.createContext({ document, Date, Map, Set, JSON, Number, String, Boolean, Array, AbortController,
    Option: class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => snapshot }; },
    setTimeout: () => 1, clearTimeout: () => {} });
  vm.runInContext(await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/snapshot');
  assert.ok(!requests[0].options.method || requests[0].options.method === 'GET');
  assert.equal(requests[0].options.credentials, 'omit');
  const text = created.map(element => element.textContent).join('\n');
  assert.ok(text.includes(hostile), 'hostile metadata remains literal text');
  assert.match(text, /Stale evidence/); assert.match(text, /Status unknown/);
  assert.match(text, /http_receipt/); assert.doesNotMatch(text, /Task completed|Worker online|Worker offline/);
  assert.equal(created.some(element => ['script', 'img', 'iframe'].includes(element.tag)), false);
});
