import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloseProvider, linuxProcessIdentity } from '../dist/pane-close.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-pane-close-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const file = path.join(root, 'worker.jsonl');
  await writeFile(file, JSON.stringify({type:'session',id:'worker'})+'\n'+JSON.stringify({type:'message',secret:'Never inspect this message'})+'\n');
  const identity = {workspaceId:'w1',paneId:'w1:p2',terminalId:'term-worker',sessionId:'worker',sessionFile:file,pid:401,processStart:'123'};
  const caller = {pane_id:'w1:p1',workspace_id:'w1',terminal_id:'term-coordinator'};
  const target = {pane_id:identity.paneId,workspace_id:identity.workspaceId,terminal_id:identity.terminalId,agent:'pi',agent_session:{kind:'path',source:'herdr:pi',value:file}};
  const calls = [], state = {closed:false,exited:false,throwClose:false,leaveProcess:false,start:'123'};
  const options = {platform:'linux',env:{HERDR_ENV:'1',HERDR_PANE_ID:'w1:p1'},pid:400,
    sessionId:()=> 'coordinator', sessionFile:()=>undefined, verificationMs:0,
    processIdentity:async()=>state.exited?undefined:{state:'S',start:state.start},
    run:async (_file,args)=> {
      calls.push(args);
      if(args[1]==='current') return JSON.stringify({result:{pane:caller}});
      if(args[1]==='get') return JSON.stringify({result:{pane:target}});
      if(args[1]==='process-info') return JSON.stringify({result:{process_info:{pane_id:identity.paneId,foreground_processes:[{pid:identity.pid}]}}});
      if(args[1]==='close') {state.closed=true;state.exited=!state.leaveProcess;if(state.throwClose)throw new Error('uncertain');return '';}
      if(args[1]==='list') return JSON.stringify({result:{panes:state.closed?[caller]:[caller,target]}});
      assert.fail('Unexpected command');
    }};
  return {identity,caller,target,calls,state,options,file};
}

test('owned Linux pane closes once after independent metadata/header/PID checks', async t=>{
  const f=await fixture(t), provider=createCloseProvider(f.options);
  await provider.inspect(f.identity,'worker',()=>{});
  assert.deepEqual(await provider.close(f.identity,'worker',()=>{},async()=>{}),{paneClosed:true,workerExited:true});
  assert.equal(f.calls.filter(a=>a[1]==='close').length,1);
  assert.ok(f.calls.filter(a=>a[1]==='close').every(a=>a.length===3&&a[2]==='w1:p2'));
});
test('self, moved, replaced, wrong session header and reused PID never close',async t=>{
  for(const kind of ['self','moved','terminal','header','pid','generation']) {
    const f=await fixture(t), provider=createCloseProvider(f.options);
    if(kind==='self') f.identity.sessionId='coordinator';
    if(kind==='moved') f.target.workspace_id='w2';
    if(kind==='terminal') f.target.terminal_id='replacement';
    if(kind==='header') await writeFile(f.file,JSON.stringify({type:'session',id:'replacement'})+'\n');
    if(kind==='pid') f.state.start='456';
    await assert.rejects(provider.close(f.identity,'worker',()=>{if(kind==='generation')throw new Error('replaced');},async()=>{}));
    assert.equal(f.calls.filter(a=>a[1]==='close').length,0,kind);
  }
});
test('close revalidates prior proof and never retries an uncertain CLI mutation',async t=>{
  const f=await fixture(t), provider=createCloseProvider(f.options);
  await provider.inspect(f.identity,'worker',()=>{});
  f.target.terminal_id='other';
  await assert.rejects(provider.close(f.identity,'worker',()=>{},async()=>{}));
  assert.equal(f.calls.filter(a=>a[1]==='close').length,0);
  f.target.terminal_id=f.identity.terminalId;f.state.throwClose=true;
  await assert.rejects(provider.close(f.identity,'worker',()=>{},async()=>{}),/uncertain/);
  assert.equal(f.calls.filter(a=>a[1]==='close').length,1);
});
test('pane removal does not claim worker exit when process remains',async t=>{
  const f=await fixture(t);f.state.leaveProcess=true;
  assert.deepEqual(await createCloseProvider(f.options).close(f.identity,'worker',()=>{},async()=>{}),{paneClosed:true,workerExited:false});
});
test('final settlement challenge rejects new activity after identity inspection without closing',async t=>{
  const f=await fixture(t);
  await assert.rejects(createCloseProvider(f.options).close(f.identity,'worker',()=>{},async()=>{
    assert.ok(f.calls.some(a=>a[1]==='process-info'));
    throw new Error('worker no longer settled');
  }),/no longer settled/);
  assert.equal(f.calls.filter(a=>a[1]==='close').length,0);
});
test('worker captures only its own current pane identity; unsupported platforms have no provider',async t=>{
  const f=await fixture(t);
  f.options.pid=401;f.options.sessionId=()=> 'worker';f.options.sessionFile=()=>f.file;
  Object.assign(f.caller,f.target);
  assert.deepEqual(await createCloseProvider(f.options).getIdentity(),f.identity);
  assert.equal(createCloseProvider({...f.options,platform:'win32'}),undefined);
  assert.equal(createCloseProvider({...f.options,env:{}}),undefined);
});
test('Linux process identity reads current process start ticks', {skip:process.platform!=='linux'},async()=>{
  const identity=await linuxProcessIdentity(process.pid);
  assert.match(identity.start,/^[0-9]+$/);
  assert.ok(!['Z','X'].includes(identity.state));
});
