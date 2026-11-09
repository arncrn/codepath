import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {startProjectService} from '../dist/service.mjs';
import {callTool} from '../client.mjs';
const base=fileURLToPath(new URL('../',import.meta.url)),assetsRoot=path.join(base,'dist');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-service-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'flow.ts'),'export function submit() { return 1; }\n');
  return root;
}
test('Managed service chooses a free port, shares agent writes and cleans up its connection',async t=>{
  const root=fixture(t),service=await startProjectService(root,{assetsRoot});
  t.after(()=>service.close());
  assert.equal(service.owned,true);
  const state=await service.request('/api/state');
  assert.equal(state.index.files.length,1);
  assert.equal(state.paths.length,0);
  const walk=await service.call('save_walkthrough',{title:'Submit',steps:[{id:'submit',title:'Submit',source:{file:'flow.ts',symbol:'submit'}}]});
  const {stdout}=await promisify(execFile)(process.execPath,[path.join(assetsRoot,'agent.mjs'),'--root',root,'--call','add_note','--args',JSON.stringify({walkthroughId:walk.id,stepId:'submit',body:'Written through the agent CLI.',author:'Agent'})]);
  assert.equal(JSON.parse(stdout).author,'Agent');
  assert.equal((await service.call('get_walkthrough',{id:walk.id})).steps[0].notes[0].body,'Written through the agent CLI.');
  assert.equal((await fetch(service.url+'/')).status,200);
  assert.equal((await fetch(service.url+'/api/state')).status,401);
  const connection=JSON.parse(fs.readFileSync(path.join(root,'.codepaths/connection.json'),'utf8'));
  assert.equal((await fetch(service.url+'/api/state',{headers:{'X-Codepath-Token':connection.token,Origin:'https://example.com'}})).status,403);
  const invalidHostStatus=await new Promise((resolve,reject)=>{
    http.get(service.url+'/api/state',{headers:{'X-Codepath-Token':connection.token,Host:'example.com'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);
  });
  assert.equal(invalidHostStatus,403);
  await service.close();
  assert.equal(fs.existsSync(path.join(root,'.codepaths/connection.json')),false);
  assert.ok(fs.existsSync(path.join(root,'.codepaths/workspace.json')));
  await assert.rejects(fetch(service.url+'/api/state'));
});
test('Attaching reuses the owner and never shuts it down or overwrites shared state',async t=>{
  const root=fixture(t),owner=await startProjectService(root,{assetsRoot});
  t.after(()=>owner.close());
  const before=fs.readFileSync(path.join(root,'.codepaths/connection.json'),'utf8');
  const attached=await startProjectService(root,{assetsRoot,reuse:true});
  assert.equal(attached.owned,false);
  assert.equal(attached.url,owner.url);
  await assert.rejects(startProjectService(root,{assetsRoot}),/already open/);
  const walk=await attached.call('save_walkthrough',{title:'Shared path',steps:[]});
  assert.equal((await owner.call('get_walkthrough',{id:walk.id})).title,'Shared path');
  await attached.close();
  assert.equal((await owner.request('/api/state')).paths.length,1);
  assert.equal(fs.readFileSync(path.join(root,'.codepaths/connection.json'),'utf8'),before);
});
test('A stale connection is recovered and persisted walkthroughs survive restart',async t=>{
  const root=fixture(t),first=await startProjectService(root,{assetsRoot});
  const walk=await first.call('save_walkthrough',{title:'Retained',steps:[]});
  await first.close();
  fs.writeFileSync(path.join(root,'.codepaths/connection.json'),JSON.stringify({port:0,token:'stale'}));
  const next=await startProjectService(root,{assetsRoot,reuse:true});
  t.after(()=>next.close());
  assert.equal(next.owned,true);
  assert.equal((await next.call('get_walkthrough',{id:walk.id})).title,'Retained');
});
test('Deleting every demo walkthrough stays empty after a real service restart',async t=>{
  const cache=path.join(assetsRoot,'.cache');fs.mkdirSync(cache,{recursive:true});
  const root=fs.mkdtempSync(path.join(cache,'demo-delete-'));
  fs.cpSync(path.join(base,'examples/checkout'),root,{recursive:true,filter:file=>!file.split(path.sep).includes('.codepaths')});
  let service;
  t.after(async()=>{await service?.close();fs.rmSync(root,{recursive:true,force:true});});
  service=await startProjectService(root,{assetsRoot:root,demo:true});
  const initial=await service.request('/api/state');
  assert.equal(initial.paths.length,3);
  for(const p of initial.paths)await service.call('delete_walkthrough',{id:p.id,expectedRevision:p.revision});
  await service.close();
  service=await startProjectService(root,{assetsRoot:root,demo:true});
  assert.deepEqual((await service.request('/api/state')).paths,[]);
});
test('Connection symlinks are rejected before startup',async t=>{
  const root=fixture(t),target=path.join(root,'untouched.json');
  fs.mkdirSync(path.join(root,'.codepaths'));
  fs.writeFileSync(target,'{}');
  fs.symlinkSync(target,path.join(root,'.codepaths/connection.json'));
  await assert.rejects(startProjectService(root,{assetsRoot,reuse:true}),/symlink/);
  assert.equal(fs.readFileSync(target,'utf8'),'{}');
});
test('Compatibility browser CLI and instrumentation client use the emitted TypeScript runtime',async t=>{
  const root=fixture(t);
  const child=spawn(process.execPath,[path.join(base,'server.mjs'),'--root',root,'--port','0'],{stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
  const exited=new Promise(resolve=>{child.once('exit',code=>resolve(code));child.once('error',error=>resolve(error));});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exited;}});
  let url;
  for(let i=0;i<150&&!url;i++){
    if(child.exitCode!==null||!child.pid)throw Error('Browser CLI exited early: '+logs);
    url=logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if(!url)await delay(20);
  }
  assert.ok(url,'CLI must print its loopback URL: '+logs);
  const html=await (await fetch(url)).text();
  assert.match(html,/id="root"/);assert.match(html,/src="\/ui.js"/);
  const bundle=await fetch(url+'/ui.js');assert.equal(bundle.status,200);assert.ok((await bundle.text()).length>1000);
  const overview=await callTool(root,'project_overview');
  assert.equal(overview.root,fs.realpathSync(root));assert.equal(overview.index.files.length,1);
  child.kill('SIGTERM');assert.equal(await exited,0);
  assert.equal(fs.existsSync(path.join(root,'.codepaths/connection.json')),false);
});
