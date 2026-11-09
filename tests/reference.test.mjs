import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openWorkspace} from '../dist/workspace.mjs';
import {selectionSource} from '../dist/vscode/bridge.mjs';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-reference-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'go'));
  fs.writeFileSync(path.join(root,'go/main.go'),'package main\nfunc main(){\n  http.HandleFunc("/api/orders",handleOrder)\n  log.Fatal(http.ListenAndServe(address,nil))\n}\n');
  fs.writeFileSync(path.join(root,'go/handler.go'),'package main\nfunc handleOrder() {}\n');
  fs.mkdirSync(path.join(root,'other'));
  fs.writeFileSync(path.join(root,'other/handler.go'),'package other\nfunc handleOrder() {}\n');
  fs.writeFileSync(path.join(root,'handler.mjs'),'export function handleOrder() {}\n');
  return openWorkspace(root);
}
test('Starting on either HandleFunc or handleOrder preserves the registration line',t=>{
  const w=fixture(t),index={files:[w.invoke('inspect_source',{file:'go/main.go'})]};
  for(const column of [8,33]){
    const step=selectionSource(index,'go/main.go',{startLine:3,endLine:3,empty:true,column});
    assert.deepEqual(step.source,{file:'go/main.go',startLine:3,endLine:3});
  }
});
test('Following a Go callback reference returns only that name in its package, not every call or Node handler',t=>{
  const w=fixture(t);
  const result=w.invoke('resolve_reference',{file:'go/main.go',line:3,column:32});
  assert.equal(result.name,'handleOrder');
  assert.deepEqual(result.candidates.map(c=>({file:c.file,name:c.name})),[{file:'go/handler.go',name:'handleOrder'}]);
  assert.equal(result.candidates[0].evidence,'inferred');
});
test('A framework identifier is not silently redirected to its registered handler',t=>{
  const w=fixture(t);
  const result=w.invoke('resolve_reference',{file:'go/main.go',line:3,column:8});
  assert.equal(result.name,'HandleFunc');
  assert.deepEqual(result.candidates,[]);
});
test('Symbol navigation rejects comments, strings and invalid positions',t=>{
  const w=fixture(t);
  assert.throws(()=>w.invoke('resolve_reference',{file:'go/main.go',line:3,column:20}),/identifier/);
  assert.throws(()=>w.invoke('resolve_reference',{file:'../outside.go',line:1,column:0}),/indexed/);
  assert.throws(()=>w.invoke('resolve_reference',{file:'go/main.go',line:3,column:-1}),/position/);
  fs.writeFileSync(path.join(w.root,'go/main.go'),'package main\n// handleOrder\n');
  assert.throws(()=>w.invoke('resolve_reference',{file:'go/main.go',line:2,column:4}),/identifier/);
});
