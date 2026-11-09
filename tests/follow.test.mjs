import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkspace} from '../dist/workspace.mjs';
function fixture(t,source){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-follow-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'entry.mjs'),source);
  fs.writeFileSync(path.join(root,'client.mjs'),'export async function callTool() { return 1; }\nexport function unused() { return 2; }\n');
  return openWorkspace(root);
}
test('Follow call scans a selected top-level call without a containing indexed function',t=>{
  const w=fixture(t,"import {callTool} from './client.mjs';\nconst result = await callTool();\n");
  const result=w.invoke('follow_calls',{source:{file:'entry.mjs',startLine:2,endLine:2}});
  assert.ok(result.candidates.some(s=>s.file==='client.mjs'&&s.name==='callTool'));
  assert.deepEqual(result.calls,[{name:'callTool',line:2}]);
  assert.deepEqual(result.unresolved,[]);
});
test('Follow call finds calls inside top-level anonymous callbacks and only in the selected lines',t=>{
  const w=fixture(t,"import {callTool, unused} from './client.mjs';\nbutton.addEventListener('click', () => callTool());\nunused();\n");
  const result=w.invoke('follow_calls',{source:{file:'entry.mjs',startLine:2,endLine:2}});
  assert.deepEqual(result.candidates.map(s=>s.name),['callTool']);
  assert.deepEqual(result.calls,[{name:'button.addEventListener',line:2},{name:'callTool',line:2}]);
  assert.deepEqual(result.unresolved,[{name:'button.addEventListener',line:2}]);
});
test('Follow call reports unresolved names separately from a range with no call expressions',t=>{
  const w=fixture(t,"import {callTool as invoke} from './client.mjs';\nawait invoke();\nconst text = 'callTool()'; // unused()\n");
  const unresolved=w.invoke('follow_calls',{source:{file:'entry.mjs',startLine:2,endLine:2}});
  assert.deepEqual(unresolved.candidates,[]);
  assert.deepEqual(unresolved.unresolved,[{name:'invoke',line:2}]);
  const noCall=w.invoke('follow_calls',{source:{file:'entry.mjs',startLine:3,endLine:3}});
  assert.deepEqual(noCall.calls,[]);
  assert.deepEqual(noCall.unresolved,[]);
});
test('A call inherited by overlapping indexed functions is reported once',t=>{
  const w=fixture(t,'function outer() {\n  const inner = () => callTool();\n  return inner();\n}\n');
  const result=w.invoke('follow_calls',{source:{file:'entry.mjs',symbol:'outer'}});
  assert.equal(result.calls.filter(c=>c.name==='callTool').length,1);
  assert.equal(result.candidates.filter(c=>c.name==='callTool').length,1);
});
