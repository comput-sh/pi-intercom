import test from 'node:test';
import assert from 'node:assert/strict';
import { workerObservation, workerStatusPage } from '../dist/worker-status.js';
import { publicCloseMetadata, readObservationSnapshot } from '../dist/snapshot.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const now = Date.parse('2026-01-01T00:01:00Z');
const stamp = ms => new Date(now - ms).toISOString();
const worker = i => ({sessionId:`w${i}`,name:`Worker-${i}`,coordinator:false});
const snapshot = (events = []) => ({version:1,generatedAt:stamp(0),staleAfterMs:60000,config:{agents:[{sessionId:'c',coordinator:true},worker(0)]},events,reports:[],errors:[],truncated:false});
const event = (overrides={}) => ({sessionId:'w0',event:'host.activity',timestamp:stamp(1000),writerId:'writer',busy:true,phase:'thinking',detail:'thinking',...overrides});
test('status JSON preserves unknown, future, stale, conflict and closed evidence', () => {
  assert.equal(workerObservation(snapshot(), 'w0', now).stale,null);
  assert.equal(workerObservation(snapshot([event()]), 'w0', now).observedStatus,'thinking');
  const old=workerObservation(snapshot([event({timestamp:stamp(61000)})]),'w0',now);
  assert.equal(old.stale,true); assert.equal(old.observationAgeSeconds,61);
  assert.equal(workerObservation(snapshot([event({timestamp:stamp(-1000)})]),'w0',now).evidence,'clock_uncertain');
  assert.equal(workerObservation(snapshot([event(),event({busy:false})]),'w0',now).evidence,'conflicting');
  assert.equal(workerObservation(snapshot([event({event:'runtime.closed'})]),'w0',now).observedStatus,'closed');
});
test('last activity persists across settlement; reports have their own timestamp and clear hides them', () => {
  const s=snapshot([event({timestamp:stamp(5000),detail:'reading_files'}),event({busy:false,phase:'idle',detail:'settled'})]);
  s.reports=[{sessionId:'w0',status:'ready_for_review',summary:'Public result',updatedAt:stamp(10000)}];
  const data=workerStatusPage(s,{},now);
  assert.equal(data.workers[0].observedStatus,'idle'); assert.equal(data.workers[0].lastActivity,'Reading files');
  assert.equal(data.workers[0].report.ageSeconds,10); assert.equal(data.workers[0].report.selfReported,true);
  s.reports[0].status='clear'; assert.equal(workerStatusPage(s,{},now).workers[0].report,null);
});
const handoff = (summary = 'Resume by reviewing the remaining tests') => ({ version: 1, jobId: 'close-1', summary, updatedAt: stamp(5000) });
const closeJob = (state = 'uncertain', reason = 'close_unverified') => ({ jobId: 'close-2', state, reason, createdAt: stamp(10000), updatedAt: stamp(2000), deadlineAt: stamp(-10000) });
test('saved public handoff remains distinct from failed or uncertain closure and activity', () => {
  const s = snapshot([event()]);
  let entry = workerStatusPage(s, {}, now).workers[0];
  assert.equal(entry.handoff, null); assert.equal(entry.closeJob, null);
  for (const [state, reason] of [['failed', 'close_failed'], ['uncertain', 'close_unverified'], ['closed', undefined]]) {
    Object.assign(s.config.agents[1], { handoff: handoff(), closeJob: closeJob(state, reason) });
    entry = workerStatusPage(s, {}, now).workers[0];
    assert.equal(entry.observedStatus, 'thinking');
    assert.equal(entry.connection.state, 'unknown');
    assert.equal(entry.handoff.summary, handoff().summary);
    assert.equal(entry.handoff.ageSeconds, 5); assert.equal(entry.handoff.selfReported, true);
    assert.equal(entry.closeJob.state, state); assert.equal(entry.closeJob.ageSeconds, 2);
    assert.equal(entry.handoff.jobId, 'close-1'); assert.equal(entry.closeJob.jobId, 'close-2');
  }
  s.config.agents[1].handoff.updatedAt = stamp(-1000);
  assert.equal(workerStatusPage(s, {}, now).workers[0].handoff.ageSeconds, null);
  for (const invalid of [{ ...handoff(), pid: 123 }, { ...handoff(), summary: 'x'.repeat(4001) }, { ...handoff(), updatedAt: 'invalid' }]) {
    assert.deepEqual(publicCloseMetadata({ handoff: invalid }), {});
  }
  assert.deepEqual(publicCloseMetadata({ closeJob: { ...closeJob(), sessionFile: '/private/session.jsonl' } }), {});
});
test('snapshot projects only validated public saved context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intercom-handoff-snapshot-'));
  try {
    await mkdir(path.join(root, '.pi-intercom'));
    const config = { version: 1, multiplexer: 'herdr', agents: [
      { sessionId: 'c', name: 'Coordinator', coordinator: true, description: 'Coordinate', projectDirectory: '.', port: 10001 },
      { ...worker(0), description: 'Review', projectDirectory: '.', port: 10002, handoff: handoff(), closeJob: closeJob(), pid: 42, sessionFile: '/private/session.jsonl' },
    ] };
    await writeFile(path.join(root, '.pi-intercom/config.json'), JSON.stringify(config));
    const s = await readObservationSnapshot(root);
    assert.deepEqual(s.config.agents[1].handoff, handoff());
    assert.deepEqual(s.config.agents[1].closeJob, closeJob());
    assert.doesNotMatch(JSON.stringify(s), /sessionFile|private|pid/);
    assert.equal(s.config.agents[0].handoff, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('maximum report plus escaped handoff makes pagination progress within40KiB', () => {
  const s = snapshot();
  s.config.agents = Array.from({ length: 30 }, (_, i) => ({ ...worker(i), handoff: handoff('\u0001'.repeat(4000)), closeJob: closeJob() }));
  s.reports = s.config.agents.map(a => ({ sessionId: a.sessionId, status: 'blocked', summary: '界'.repeat(2000), updatedAt: stamp(0) }));
  let offset = 0, count = 0;
  do {
    const page = workerStatusPage(s, { offset, limit: 20 }, now);
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 40000);
    assert.ok(page.workers.length > 0);
    assert.equal(page.workers[0].handoff.summary.length, 4000);
    count += page.workers.length; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(count, 30);
});

test('pagination and name selection return bounded, valid complete JSON', () => {
  const s=snapshot(); s.config.agents=Array.from({length:100},(_,i)=>worker(i));
  s.reports=s.config.agents.map(a=>({sessionId:a.sessionId,status:'blocked',summary:'界'.repeat(2000),updatedAt:stamp(0)}));
  let offset=0,count=0;
  do { const data=workerStatusPage(s,{offset,limit:20},now); const json=JSON.stringify(data,null,2);
    assert.ok(Buffer.byteLength(json)<41000); assert.ok(data.workers.length>0); JSON.parse(json);
    count+=data.workers.length; offset=data.nextOffset;
  } while(offset!==null);
  assert.equal(count,100);
  assert.equal(workerStatusPage(s,{name:'worker-12'},now).workers[0].sessionId,'w12');
  assert.throws(()=>workerStatusPage(s,{name:'missing'},now),/not found/);
  for(const options of [{offset:-1},{limit:0},{limit:21},{offset:0.5}]) assert.throws(()=>workerStatusPage(s,options,now),/pagination/);
  s.config=null;s.errors=['config_unavailable'];
  assert.deepEqual(workerStatusPage(s,{},now).workers,[]);
  assert.deepEqual(workerStatusPage(s,{},now).errors,['config_unavailable']);
});
