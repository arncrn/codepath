import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openWorkspace} from '../dist/workspace.mjs';
import {indexProject,read} from '../dist/indexer.mjs';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'flow.ts'),'export function submit() {\n  return saveOrder();\n}\nexport const saveOrder = () => ({id: 1});\n');
  fs.writeFileSync(path.join(root,'App.tsx'),'export function App(){ return <button onClick={() => submit()}>Submit</button>; }\n');
  fs.writeFileSync(path.join(root,'flow.go'),'package demo\nfunc Handle() int {\n // } not a real brace\n return Save()\n}\nfunc Save() int { return 1 }\n');
  return root;
}
test('Indexes TS, React and Go and suggests an explicitly uncertain next call',t=>{
  const root=fixture(t);
  // Force continuation deterministically instead of relying on CPU scheduling
  // to consume the source query's per-page work/time budget.
  fs.mkdirSync(path.join(root,'000-assets'));
  for(let i=0;i<251;i++)fs.writeFileSync(path.join(root,'000-assets',`asset-${i}.txt`),'asset');
  const index=indexProject(root);
  assert.equal(index.files.length,3);
  assert.ok(index.files.find(f=>f.file==='App.tsx').symbols.some(s=>s.name==='App'));
  assert.equal(index.files.find(f=>f.file==='flow.go').symbols.length,2);
  const w=openWorkspace(root);
  const source={file:'flow.ts',symbol:'submit'};
  let result=w.invoke('follow_calls',{source});
  const candidates=[...result.candidates];
  for(let page=0;!result.complete&&page<100;page++){
    assert.ok(result.nextCursor,'An incomplete source search must provide continuation.');
    result=w.invoke('follow_calls',{source,cursor:result.nextCursor});
    candidates.push(...result.candidates);
  }
  assert.equal(result.complete,true,'The complete fixture search must finish.');
  assert.ok(candidates.some(s=>s.name==='saveOrder'));
  assert.match(result.limitation,/not a resolved call graph/);
});
test('Notes survive reload, line moves and path updates; edits mark them stale',t=>{
  const root=fixture(t),w=openWorkspace(root);
  const p=w.invoke('save_walkthrough',{title:'Submit',steps:[{id:'submit',title:'Submit',source:{file:'flow.ts',symbol:'submit'}}]});
  w.invoke('add_note',{walkthroughId:p.id,stepId:'submit',body:'Calls saveOrder.',author:'Test agent'});
  assert.throws(()=>w.invoke('save_walkthrough',{id:p.id,title:p.title,steps:p.steps,expectedRevision:p.revision}),/Path changed/);
  const current=w.invoke('get_walkthrough',{id:p.id});
  w.invoke('save_walkthrough',{id:p.id,title:'Submit request',steps:current.steps,expectedRevision:current.revision});
  let content=fs.readFileSync(path.join(root,'flow.ts'),'utf8');
  fs.writeFileSync(path.join(root,'flow.ts'),'// moved\n'+content);
  assert.equal(w.invoke('get_walkthrough',{id:p.id}).steps[0].notes[0].stale,false);
  content=fs.readFileSync(path.join(root,'flow.ts'),'utf8').replace('return saveOrder();','return {wrapped: saveOrder()};');
  fs.writeFileSync(path.join(root,'flow.ts'),content);
  const reload=openWorkspace(root).invoke('get_walkthrough',{id:p.id});
  assert.equal(reload.steps[0].notes[0].stale,true);
  assert.equal(reload.steps[0].notes[0].author,'Test agent');
});
test('Data provenance remains explicit and unrecognized step events are rejected',t=>{
  const w=openWorkspace(fixture(t));
  const p=w.invoke('save_walkthrough',{title:'Submit',steps:[{id:'submit',title:'Submit',source:{file:'flow.ts',symbol:'submit'}}]});
  const run=w.invoke('record_run',{walkthroughId:p.id,label:'Dummy values',mode:'example',origin:'Invented fixture',events:[{stepId:'submit',input:1,output:2}]});
  assert.equal(w.invoke('get_run',{id:run.id}).mode,'example');
  assert.throws(()=>w.invoke('record_run',{walkthroughId:p.id,label:'Bad',mode:'recorded',origin:'Test',events:[{stepId:'unknown'}]}),/Unknown event step/);
});
test('Indexing and reads accept a project opened through a directory alias',t=>{
  const root=fixture(t),parent=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-alias-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const alias=path.join(parent,'project');
  fs.symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');
  const index=indexProject(alias);
  assert.equal(index.files.length,3);
  assert.deepEqual(index.warnings,[]);
  assert.match(read(alias,'flow.ts'),/export function submit/);
});
test('Read access rejects paths outside the project and scanner skips dependencies',t=>{
  const root=fixture(t);
  assert.throws(()=>read(root,'../outside.ts'),/relative source filename/);
  fs.mkdirSync(path.join(root,'node_modules'));
  fs.writeFileSync(path.join(root,'node_modules','ignore.js'),'function hidden(){}');
  assert.equal(indexProject(root).files.length,3);
});
