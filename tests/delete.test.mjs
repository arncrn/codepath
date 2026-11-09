import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkspace} from '../dist/workspace.mjs';
import {tools} from '../dist/tools.mjs';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-delete-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'flow.ts'),'export function submit() { return 1; }\n');
  const w=openWorkspace(root);
  const create=title=>w.invoke('save_walkthrough',{title,steps:[{id:'start',title:'Submit',source:{file:'flow.ts',symbol:'submit'}}]});
  return {w,create};
}
test('Deleting a walkthrough removes its notes, runs and focus, persists, and leaves source and other walkthroughs untouched',t=>{
  const {w,create}=fixture(t),deleted=create('Delete me'),kept=create('Keep me');
  const note=w.invoke('add_note',{walkthroughId:kept.id,stepId:'start',body:'Keep this note.',author:'Agent'});
  w.invoke('add_note',{walkthroughId:deleted.id,stepId:'start',body:'Delete this note.',author:'User'});
  const run=id=>w.invoke('record_run',{walkthroughId:id,label:'Fixture',mode:'example',origin:'Test fixture',events:[{stepId:'start',output:1}]});
  const deletedRun=run(deleted.id),keptRun=run(kept.id);
  w.invoke('focus_step',{walkthroughId:deleted.id,stepId:'start'});
  const current=w.invoke('get_walkthrough',{id:deleted.id});
  const beforeSource=fs.readFileSync(path.join(w.root,'flow.ts'),'utf8');
  assert.deepEqual(w.invoke('delete_walkthrough',{id:deleted.id,expectedRevision:current.revision}),{id:deleted.id,deleted:true});
  const reload=openWorkspace(w.root);
  assert.deepEqual(reload.overview().paths.map(p=>p.id),[kept.id]);
  assert.equal(reload.overview().focus,null);
  assert.throws(()=>reload.invoke('get_walkthrough',{id:deleted.id}),/not found/);
  assert.throws(()=>reload.invoke('get_run',{id:deletedRun.id}),/not found/);
  assert.equal(reload.invoke('get_run',{id:keptRun.id}).walkthroughId,kept.id);
  assert.equal(reload.invoke('get_walkthrough',{id:kept.id}).steps[0].notes[0].id,note.id);
  assert.equal(fs.readFileSync(path.join(w.root,'flow.ts'),'utf8'),beforeSource);
});
test('Deletion requires the confirmed revision and rejects notes or runs added after confirmation',t=>{
  for(const change of ['note','run']){
    const {w,create}=fixture(t),p=create('Changed after confirmation');
    assert.throws(()=>w.invoke('delete_walkthrough',{id:p.id}),/Review it again/);
    if(change==='note')w.invoke('add_note',{walkthroughId:p.id,stepId:'start',body:'New work',author:'Agent'});
    else w.invoke('record_run',{walkthroughId:p.id,label:'New fixture',mode:'example',origin:'Test',events:[]});
    const before=fs.readFileSync(path.join(w.dir,'workspace.json'),'utf8');
    assert.throws(()=>w.invoke('delete_walkthrough',{id:p.id,expectedRevision:p.revision}),/Review it again/);
    assert.equal(w.overview().paths.length,1);
    assert.equal(fs.readFileSync(path.join(w.dir,'workspace.json'),'utf8'),before);
  }
});
test('A stale save cannot resurrect a deleted walkthrough',t=>{
  const {w,create}=fixture(t),p=create('Deleted');
  w.invoke('delete_walkthrough',{id:p.id,expectedRevision:p.revision});
  assert.throws(()=>w.invoke('save_walkthrough',{...p,expectedRevision:p.revision}),/no longer exists/);
  assert.deepEqual(w.overview().paths,[]);
});
test('Deleting an unfocused walkthrough preserves focus; deleting the last leaves a persisted empty workspace',t=>{
  const {w,create}=fixture(t),first=create('First'),last=create('Last');
  const focus=w.invoke('focus_step',{walkthroughId:last.id,stepId:'start'});
  w.invoke('delete_walkthrough',{id:first.id,expectedRevision:first.revision});
  assert.deepEqual(w.overview().focus,focus);
  w.invoke('delete_walkthrough',{id:last.id,expectedRevision:last.revision});
  const reload=openWorkspace(w.root);
  assert.deepEqual(reload.overview().paths,[]);
  assert.equal(reload.overview().focus,null);
  assert.equal(reload.isNew,false,'An intentionally emptied demo must not be seeded on restart.');
  assert.throws(()=>reload.invoke('delete_walkthrough',{id:last.id,expectedRevision:last.revision}),/not found/);
});
test('A persistence failure leaves the walkthrough available in memory and on disk',t=>{
  const {w,create}=fixture(t),p=create('Keep if save fails');
  const file=path.join(w.dir,'workspace.json'),backup=file+'.backup';
  fs.renameSync(file,backup);fs.mkdirSync(file); // Force atomic rename to fail.
  try{
    assert.throws(()=>w.invoke('delete_walkthrough',{id:p.id,expectedRevision:p.revision}));
    assert.equal(w.invoke('get_walkthrough',{id:p.id}).title,p.title);
  }finally{fs.rmdirSync(file);fs.renameSync(backup,file);}
  assert.equal(openWorkspace(w.root).invoke('get_walkthrough',{id:p.id}).title,p.title);
});
test('Agent deletion tool is explicitly destructive and requires a revision',()=>{
  const tool=tools.find(t=>t.name==='delete_walkthrough');
  assert.ok(tool);
  assert.equal(tool.annotations.destructiveHint,true);
  assert.equal(tool.annotations.readOnlyHint,false);
  assert.deepEqual(tool.inputSchema.required,['id','expectedRevision']);
});
