import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startProjectService} from '../dist/service.mjs';
import {selectionSource,dispatchWebviewRequest,webviewHtml} from '../dist/vscode/bridge.mjs';
const assetsRoot=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-bridge-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'flow.ts'),'export function submit() {\n  return save();\n}\nexport function save() { return 1; }\n');
  const service=await startProjectService(root,{assetsRoot});
  t.after(()=>service.close());
  return service;
}
test('A cursor starts at its line instead of expanding to the containing function',async t=>{
  const service=await fixture(t),index={files:[await service.call('inspect_source',{file:'flow.ts'})]};
  assert.deepEqual(selectionSource(index,'flow.ts',{startLine:2,endLine:2,empty:true}),{title:'flow.ts · lines 2–2',source:{file:'flow.ts',startLine:2,endLine:2}});
  assert.deepEqual(selectionSource(index,'flow.ts',{startLine:2,endLine:3,empty:false}).source,{file:'flow.ts',startLine:2,endLine:3});
  assert.deepEqual(selectionSource(index,'flow.ts',{startLine:5,endLine:5,empty:true}).source,{file:'flow.ts',startLine:5,endLine:5});
  assert.throws(()=>selectionSource(index,'../outside.ts',{startLine:1,endLine:1,empty:true}),/not indexed/);
  assert.throws(()=>selectionSource(index,'flow.ts',{startLine:1,endLine:500,empty:false}),/outside/);
});
test('Webview protocol reads and writes the real service, preserving revision conflicts',async t=>{
  const service=await fixture(t);
  assert.equal((await dispatchWebviewRequest(service,'/api/state')).index.files.length,1);
  const step={id:'start',title:'Submit',source:{file:'flow.ts',symbol:'submit'}};
  const walk=await dispatchWebviewRequest(service,'/api/call',{name:'save_walkthrough',arguments:{title:'Submit',steps:[step]}});
  await service.call('add_note',{walkthroughId:walk.id,stepId:'start',body:'Keep this note.',author:'Agent'});
  await assert.rejects(dispatchWebviewRequest(service,'/api/call',{name:'save_walkthrough',arguments:{...walk,expectedRevision:walk.revision}}),/Path changed/);
  assert.deepEqual(await dispatchWebviewRequest(service,'open-source',{walkthroughId:walk.id,stepId:'start'}),{file:'flow.ts',startLine:1,endLine:3});
  await assert.rejects(dispatchWebviewRequest(service,'open-source',{walkthroughId:walk.id,stepId:'missing',file:'../outside.ts'}),/no longer available/);
  await assert.rejects(dispatchWebviewRequest(service,'https://example.com'));
  await assert.rejects(dispatchWebviewRequest(service,'/api/call',{name:'not_a_tool'}));
  await assert.rejects(dispatchWebviewRequest(service,'/api/call',{name:'save_walkthrough',arguments:{title:'x'.repeat(2*1024*1024)}}),/2 MiB/);
});
test('Webview uses packaged resources and a nonce CSP, without localhost access or a session token',()=>{
  const template=fs.readFileSync(path.join(assetsRoot,'ui.html'),'utf8');
  const html=webviewHtml(template,{
    styleUri:'https://resource.test/style.css',themeUri:'https://resource.test/vscode.css',scriptUri:'https://resource.test/ui.js',
    cspSource:'https://resource.test',config:{root:'/project/</script><script>oops',toolRoot:'/extension/dist'}
  });
  assert.match(html,/Content-Security-Policy/);
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/script-src 'nonce-/);
  assert.match(html,/href="https:\/\/resource.test\/style.css"/);
  assert.match(html,/href="https:\/\/resource.test\/vscode.css"/);
  assert.match(html,/nonce="[a-f0-9]+" src="https:\/\/resource.test\/ui.js"/);
  assert.doesNotMatch(html,/CODEPATH_TOKEN|127\.0\.0\.1|<script>oops/);
  assert.match(html,/"host":"vscode","demo":false/);
});
