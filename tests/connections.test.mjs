import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen } from '../dist/transport.js';
import { probeWorker, probeWorkers, currentConnection, sortWorkersByConnection } from '../dist/connections.js';

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    instance.close(error => error ? reject(error) : resolve());
    instance.closeAllConnections();
  }));
  return instance.address().port;
}
async function endpoint(t, health) {
  let deliveries = 0;
  const listener = await listen(undefined, async () => { deliveries++; }, health);
  t.after(() => listener.close());
  return { ...listener, deliveries: () => deliveries };
}
function get(port, method = 'GET', route = '/intercom/health') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}
const agent = port => ({ sessionId: 'worker', port });

// These tests use actual loopback HTTP rather than mocks: GET must not invoke
// message acceptance or mistake the process occupying an old port for its owner.
test('health endpoint is side-effect-free, exact-route GET only and generic on lifecycle failure', async t => {
  let ready = true, calls = 0;
  const listener = await endpoint(t, () => {
    calls++;
    if (!ready) throw new Error('private lifecycle details');
    return { version: 1, sessionId: 'worker', secret: 'must not be returned' };
  });
  assert.deepEqual(await get(listener.port), { status: 200, body: '{"version":1,"sessionId":"worker"}' });
  assert.equal((await get(listener.port, 'POST')).status, 404);
  assert.equal((await get(listener.port, 'GET', '/intercom/health?extra=1')).status, 404);
  assert.equal(calls, 1);
  ready = false;
  assert.deepEqual(await get(listener.port), { status: 503, body: '{"error":"health unavailable"}' });
  assert.equal(listener.deliveries(), 0);
  const legacy = await endpoint(t);
  assert.equal((await get(legacy.port)).status, 404);
  assert.equal((await probeWorker(agent(legacy.port))).reason, 'legacy');
  assert.equal(legacy.deliveries(), 0);
});

test('matching identity connects; identity mismatch disconnects but unsupported versions stay unknown', async t => {
  const listener = await endpoint(t, () => ({ version: 1, sessionId: 'worker' }));
  const input = Object.freeze(agent(listener.port));
  const result = await probeWorker(input);
  assert.equal(result.state, 'connected'); assert.equal(result.reason, 'verified');
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  const mismatch = await probeWorker({ ...input, sessionId: 'other' });
  assert.equal(mismatch.state, 'disconnected'); assert.equal(mismatch.reason, 'identity_mismatch');
  for (const sessionId of ['worker', 'other']) {
    const future = await server(t, (_req, res) => res.end(JSON.stringify({ version: 2, sessionId })));
    const unsupported = await probeWorker(agent(future));
    assert.equal(unsupported.state, 'unknown'); assert.equal(unsupported.reason, 'unsupported_version');
  }
  assert.deepEqual(input, agent(listener.port));
  assert.equal(listener.deliveries(), 0);
});

test('legacy, bad bodies, oversized bodies and HTTP errors remain unknown; redirects never followed', async t => {
  let destinationHits = 0;
  const destination = await server(t, (_req, res) => { destinationHits++; res.end('{"version":1,"sessionId":"worker"}'); });
  const cases = [
    [404, '', 'legacy'], [503, '', 'http_error'],
    [302, '', 'http_error'], [200, 'not json', 'malformed'],
    [200, '[]', 'malformed'], [200, '{}', 'malformed'],
    [200, '{"version":1,"sessionId":""}', 'malformed'],
    [200, 'x'.repeat(1025), 'oversize'],
    [200, '{"version":1,"sessionId":"worker","padding":"' + 'x'.repeat(1024) + '"}', 'oversize'],
  ];
  for (const [status, body, reason] of cases) {
    let requests = 0;
    const port = await server(t, (req, res) => {
      requests++;
      assert.equal(req.method, 'GET'); assert.equal(req.url, '/intercom/health');
      assert.equal(req.socket.localAddress, '127.0.0.1');
      res.writeHead(status, { location: `http://127.0.0.1:${destination}/intercom/health` }); res.end(body);
    });
    const result = await probeWorker(agent(port));
    assert.equal(result.state, 'unknown'); assert.equal(result.reason, reason);
    assert.equal(requests, 1);
  }
  assert.equal(destinationHits, 0);
  const largeHeaders = await server(t, (_req, res) => {
    res.writeHead(200, { 'x-padding': 'x'.repeat(4096) });
    res.end('{"version":1,"sessionId":"worker"}');
  });
  const oversized = await probeWorker(agent(largeHeaders));
  assert.equal(oversized.state, 'unknown'); assert.equal(oversized.reason, 'network_error');
});

test('refusal and total deadline (including slow-drip body) are disconnected', async t => {
  const closed = await listen(undefined, async () => {});
  await closed.close();
  const refused = await probeWorker(agent(closed.port));
  assert.equal(refused.state, 'disconnected'); assert.equal(refused.reason, 'refused');
  for (const drip of [false, true]) {
    const port = await server(t, (_req, res) => {
      if (!drip) return;
      res.writeHead(200); res.write('{');
      const interval = setInterval(() => res.write(' '), 5);
      res.on('close', () => clearInterval(interval));
    });
    const started = Date.now();
    const result = await probeWorker(agent(port), { timeoutMs: 60 });
    assert.equal(result.state, 'disconnected'); assert.equal(result.reason, 'timeout');
    assert.ok(Date.now() - started < 1500, 'deadline must bound slow-drip body');
  }
});

test('aborted calls and invalid input never report disconnected or deliver requests', async t => {
  let requests = 0;
  const port = await server(t, (_req, _res) => { requests++; });
  const preAborted = AbortSignal.abort();
  assert.equal((await probeWorker(agent(port), { signal: preAborted })).reason, 'aborted');
  assert.equal(requests, 0);
  for (const invalid of [0, -1, 65536, 1.5, NaN, Infinity]) {
    const result = await probeWorker(agent(invalid));
    assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'invalid_input');
  }
  const controller = new AbortController();
  const result = probeWorker(agent(port), { signal: controller.signal, timeoutMs: 4000 });
  const timer = setTimeout(() => controller.abort(), 40);
  t.after(() => clearTimeout(timer));
  assert.equal((await result).reason, 'aborted');
  assert.ok(requests <= 1);
});

test('batch caps allocation and probes to 256, preserves order and enforces concurrency', async t => {
  let active = 0, maximum = 0, requests = 0;
  const port = await server(t, (_req, res) => {
    active++; requests++; maximum = Math.max(maximum, active);
    const timer = setTimeout(() => { active--; res.end('{"version":1,"sessionId":"worker"}'); }, 2);
    res.on('close', () => clearTimeout(timer));
  });
  const inputs = Object.freeze(Array.from({ length: 270 }, (_, i) => Object.freeze({ sessionId: `worker-${i}`, port })));
  const results = await probeWorkers(inputs, { concurrency: 999, timeoutMs: Infinity, budgetMs: Infinity });
  assert.equal(results.length, 256); assert.equal(requests, 256);
  assert.ok(maximum <= 16);
  assert.deepEqual(results.map(item => item.sessionId), inputs.slice(0, 256).map(item => item.sessionId));
  assert.ok(results.every(item => item.reason === 'identity_mismatch'));
});

test('batch budget and cancellation abort active sockets; unvisited workers stay not_checked', async t => {
  let sockets = 0, requests = 0;
  const port = await server(t, (req, _res) => {
    requests++; sockets++;
    req.socket.on('close', () => { sockets--; });
  });
  const inputs = Array.from({ length: 20 }, (_, i) => ({ sessionId: `worker-${i}`, port }));
  const start = Date.now();
  const results = await probeWorkers(inputs, { concurrency: 2, timeoutMs: 4000, budgetMs: 60 });
  assert.ok(Date.now() - start < 1500);
  assert.equal(requests, 2);
  assert.ok(results.slice(0, 2).every(item => item.state === 'unknown' && item.reason === 'aborted'));
  assert.ok(results.slice(2).every(item => item.state === 'unknown' && item.reason === 'not_checked' && item.checkedAt === null));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sockets, 0);
  const pre = await probeWorkers(inputs, { signal: AbortSignal.abort() });
  assert.ok(pre.every(item => item.state === 'unknown' && item.reason === 'aborted'));
  assert.equal(requests, 2);
  const controller = new AbortController();
  const pending = probeWorkers(inputs, { signal: controller.signal, concurrency: 1, timeoutMs: 4000 });
  const timer = setTimeout(() => controller.abort(), 40);
  t.after(() => clearTimeout(timer));
  const cancelled = await pending;
  assert.equal(cancelled[0].reason, 'aborted');
  assert.ok(cancelled.slice(1).every(item => item.reason === 'not_checked'));
});

test('current health normalization and sorting are stable, read-only and expire old failures', () => {
  const now = Date.now();
  const workers = Object.freeze(['a', 'b', 'c', 'd'].map(sessionId => Object.freeze({ sessionId })));
  const disconnected = (sessionId, age = 0) => Object.freeze({ sessionId, state: 'disconnected', checkedAt: new Date(now - age).toISOString(), reason: 'refused' });
  const checks = Object.freeze([disconnected('a'), disconnected('c'), disconnected('d', 30001)]);
  assert.deepEqual(sortWorkersByConnection(workers, checks, now).map(w => w.sessionId), ['b', 'd', 'a', 'c']);
  assert.deepEqual(workers.map(w => w.sessionId), ['a', 'b', 'c', 'd']);
  assert.equal(currentConnection('d', checks, now).reason, 'stale');
  assert.equal(currentConnection('a', [disconnected('a', 30000)], now).state, 'disconnected');
  assert.equal(currentConnection('a', [disconnected('a', -1)], now).reason, 'stale');
  assert.equal(currentConnection('a', [{ ...disconnected('a'), checkedAt: 'invalid' }], now).state, 'unknown');
  assert.equal(currentConnection('a', [{ ...disconnected('a'), checkedAt: null }], now).reason, 'not_checked');
  assert.deepEqual(currentConnection('missing', checks, now), { sessionId: 'missing', state: 'unknown', checkedAt: null, reason: 'not_checked' });
  assert.deepEqual(sortWorkersByConnection(workers, checks, now + 30001), workers);
  assert.deepEqual(sortWorkersByConnection(workers), workers);
  assert.notEqual(sortWorkersByConnection(workers), workers);
});
