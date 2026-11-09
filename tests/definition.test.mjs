import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startProjectService} from '../dist/service.mjs';
import {followReference} from '../dist/vscode/definition.mjs';
const assetsRoot=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-definition-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'main.go'),'package main\nfunc main(){\n  http.HandleFunc("/api/orders",handleOrder)\n}\n');
  fs.writeFileSync(path.join(root,'handler.go'),'package main\nfunc handleOrder() {}\n');
  const service=await startProjectService(root,{assetsRoot});t.after(()=>service.close());
  const walk=await service.call('save_walkthrough',{title:'Request',steps:[{id:'register',title:'Register route',source:{file:'main.go',startLine:3,endLine:3}}]});
  const context={walkthroughId:walk.id,stepId:'register',fileHash:walk.steps[0].code.fileHash,line:3,column:32};
  return {service,context};
}
test('Following a single callback inserts it directly after the registration and preserves notes',async t=>{
  const {service,context}=await fixture(t);
  await service.call('add_note',{walkthroughId:context.walkthroughId,stepId:context.stepId,body:'Registered, not executed.',author:'Agent'});
  const result=await followReference(service,context);
  const walk=await service.call('get_walkthrough',{id:context.walkthroughId});
  assert.equal(walk.steps.length,2);
  assert.equal(walk.steps[1].source.file,'handler.go');
  assert.equal(walk.steps[1].source.symbol,'handleOrder');
  assert.equal(walk.steps[1].evidence,'inferred');
  assert.equal(walk.steps[1].explanation,'');
  assert.equal(walk.steps[0].notes[0].body,'Registered, not executed.');
  assert.equal((await service.request('/api/state')).focus.stepId,result.stepId);
});
test('VS Code definition locations take precedence and preserve edits made during lookup',async t=>{
  const {service,context}=await fixture(t);
  const result=await followReference(service,context,{findDefinitions:async()=>{
    await service.call('add_note',{walkthroughId:context.walkthroughId,stepId:context.stepId,body:'Written during lookup.',author:'Agent'});
    return {locations:[{file:'handler.go',startLine:2,endLine:2}],external:false};
  }});
  assert.ok(result.stepId);
  const walk=await service.call('get_walkthrough',{id:context.walkthroughId});
  assert.equal(walk.steps[1].evidence,'source');
  assert.equal(walk.steps[1].explanation,'','Navigation provenance is not an explanation of the highlighted code.');
  assert.equal(walk.steps[0].notes[0].body,'Written during lookup.');
});
test('External definitions are not replaced by unrelated project name matches',async t=>{
  const {service,context}=await fixture(t);
  const result=await followReference(service,context,{findDefinitions:async()=>({locations:[],external:true})});
  assert.match(result.message,/No in-project definition/);
  assert.equal((await service.call('get_walkthrough',{id:context.walkthroughId})).steps.length,1);
});
test('Only genuinely ambiguous definitions ask for a choice; cancelling leaves the path unchanged',async t=>{
  const {service,context}=await fixture(t);
  fs.writeFileSync(path.join(service.root,'other.go'),'package main\nfunc handleOrder() {}\n');
  let offered;
  const result=await followReference(service,context,{choose:async candidates=>{offered=candidates;return null;}});
  assert.equal(result.cancelled,true);
  assert.deepEqual(offered.map(c=>c.source.file).sort(),['handler.go','other.go']);
  assert.equal((await service.call('get_walkthrough',{id:context.walkthroughId})).steps.length,1);
});
test('Stale card positions and changes during lookup are rejected without inserting a step',async t=>{
  const {service,context}=await fixture(t);
  await assert.rejects(followReference(service,{...context,fileHash:'old'}),/Source changed/);
  await assert.rejects(followReference(service,context,{findDefinitions:async()=>{
    fs.appendFileSync(path.join(service.root,'main.go'),'// edited during lookup\n');
    return {locations:[{file:'handler.go',startLine:2,endLine:2}],external:false};
  }}),/Source changed/);
  assert.equal((await service.call('get_walkthrough',{id:context.walkthroughId})).steps.length,1);
});
test('Provider locations outside indexed source are never inserted',async t=>{
  const {service,context}=await fixture(t);
  const result=await followReference(service,context,{findDefinitions:async()=>({locations:[{file:'../outside.go',startLine:1,endLine:1}],external:false})});
  assert.ok(result.message);
  assert.equal((await service.call('get_walkthrough',{id:context.walkthroughId})).steps.length,1);
});
