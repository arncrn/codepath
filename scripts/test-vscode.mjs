import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {callTool} from '../dist/client.mjs';
const base=fileURLToPath(new URL('../',import.meta.url));
const macExecutables=['/Applications/Visual Studio Code.app/Contents/MacOS/Code','/Applications/Visual Studio Code.app/Contents/MacOS/Electron'];
const executable=process.env.VSCODE_EXECUTABLE??(process.platform==='darwin'?macExecutables.find(p=>fs.existsSync(p))??'code':'code');
const extensionPath=process.env.CODEPATH_TEST_EXTENSION_DIR??base;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codepath-vscode-'));
const root=path.join(dir,'app');fs.mkdirSync(root);
fs.writeFileSync(path.join(root,'flow.ts'),"export function submit() {\n  return save();\n}\nexport function save() { return 1; }\nsave();\nimport {persist as storeOrder} from './store';\nstoreOrder();\n");
fs.writeFileSync(path.join(root,'store.ts'),'export function persist() { return 1; }\n');
fs.cpSync(path.join(base,'examples/checkout/go'),path.join(root,'go'),{recursive:true});
const settingsDir=path.join(dir,'profile/User');fs.mkdirSync(settingsDir,{recursive:true});
fs.writeFileSync(path.join(settingsDir,'settings.json'),JSON.stringify({'extensions.autoUpdate':false}));
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const child=spawn(executable,[
  '--new-window','--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-updates',
  '--user-data-dir='+path.join(dir,'profile'),'--extensions-dir='+path.join(dir,'extensions'),
  '--extensionDevelopmentPath='+extensionPath,'--extensionTestsPath='+path.join(base,'vscode/test-runner.cjs'),
  '--remote-debugging-port='+port,root
],{env:{...process.env,CODEPATH_TEST_DIR:dir,ELECTRON_RUN_AS_NODE:''},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
const exited=new Promise(resolve=>{child.on('exit',code=>resolve(code));child.on('error',e=>{logs+=e.stack;resolve(-1);});});
let browser,frameForDiagnostics;
try{
  for(let i=0;!fs.existsSync(path.join(dir,'host-ready.json'))&&i<600;i++){
    if(child.exitCode!==null||!child.pid)throw Error('VS Code exited early.\n'+logs);
    await delay(100);
  }
  assert.ok(fs.existsSync(path.join(dir,'host-ready.json')),'Host tests must become ready.\n'+logs);
  // Exercise the shipped agent too, including when testing an unpacked VSIX
  // outside this checkout with no neighboring node_modules.
  const {stdout:agentState}=await promisify(execFile)(process.execPath,[path.join(extensionPath,'dist/agent.mjs'),'--root',root,'--call','project_overview']);
  assert.equal(JSON.parse(agentState).root,fs.realpathSync(root));
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  let frame;
  for(let i=0;!frame&&i<200;i++){
    for(const page of browser.contexts().flatMap(c=>c.pages())){
      for(const candidate of page.frames()){
        if(await candidate.locator('#rail').count()){frame=candidate;break;}
      }
    }
    if(!frame)await delay(100);
  }
  assert.ok(frame,'Codepath webview must load.');
  frameForDiagnostics=frame;
  await frame.locator('.code-card').first().waitFor();
  assert.equal(await frame.locator('#title').innerText(),'Explore flow.ts · lines 5–5');
  assert.equal(await frame.locator('.code-card').count(),1);
  assert.equal(await frame.locator('#error').isVisible(),false);
  assert.equal(await frame.getByRole('button',{name:'Callback role…',exact:true}).count(),0);
  assert.equal(await frame.evaluate(()=>window.CODEPATH_TOKEN),undefined);
  await frame.getByRole('button',{name:'Notes · 0',exact:true}).click();
  await frame.locator('#note-text').fill('Note from the VS Code webview.');
  await frame.getByRole('button',{name:'Save note',exact:true}).click();
  await frame.getByText('Note from the VS Code webview.',{exact:true}).waitFor();
  for(const selector of ['#description','.eyebrow','.source-usages','.card-review','.note-details','.archived-notes'])assert.equal(await frame.locator(selector).count(),0,'Unrequested reading UI must not return in the native webview: '+selector);
  await frame.locator('#notes .note').getByRole('button',{name:'Edit',exact:true}).click();
  assert.equal(await frame.locator('.review-guards').count(),0);
  await frame.locator('.annotation-editor').getByLabel('Reviewed explanation').fill('Edited from the native webview.');
  await frame.getByRole('button',{name:'Save reviewed explanation',exact:true}).click();
  await frame.locator('#notes .note').getByText('Edited from the native webview.',{exact:true}).waitFor();
  const editedWalk=await callTool(root,'get_walkthrough',{id:await frame.locator('#paths button.selected').getAttribute('data-path')});
  assert.ok(editedWalk.steps[0].notes[0].history.some(version=>version.body==='Note from the VS Code webview.'));
  assert.equal(await frame.getByText('Prior versions',{exact:true}).count(),0);
  await frame.locator('code[data-source-line="5"]').evaluate(code=>{const range=document.createRange();range.selectNodeContents(code);globalThis.getSelection().removeAllRanges();globalThis.getSelection().addRange(range);code.dispatchEvent(new globalThis.MouseEvent('mouseup',{bubbles:true}));});
  await frame.getByRole('button',{name:'Create note',exact:true}).click();
  const blockEditor=frame.locator('#notes-panel .annotation-editor');
  await blockEditor.getByRole('textbox',{name:'Note',exact:true}).fill('Native block note.');
  await blockEditor.getByRole('button',{name:'Save note',exact:true}).click();
  await frame.locator('#notes .note').getByText('Native block note.',{exact:true}).waitFor();
  const nativeBlock=(await callTool(root,'get_walkthrough',{id:editedWalk.id})).steps[0].notes.find(note=>note.body==='Native block note.');
  assert.equal(nativeBlock.attachments[0].startLine,5);
  assert.equal(nativeBlock.attachments[0].endLine,5);
  const marker=frame.locator('[data-block-note-id="'+nativeBlock.id+'"]');
  assert.equal(await marker.count(),1);
  assert.equal(await marker.evaluate(element=>globalThis.getComputedStyle(element).backgroundColor),await frame.locator('#notes [data-explanation-id="'+nativeBlock.id+'"]').evaluate(element=>globalThis.getComputedStyle(element).borderLeftColor));
  assert.equal(await frame.locator('[data-action="follow"]').count(),0);
  await frame.locator('.line.focus [data-source-name="save"]').click({modifiers:[process.platform==='darwin'?'Meta':'Control']});
  await frame.locator('.code-card').nth(1).waitFor();
  assert.equal(await frame.locator('.code-card').count(),2);
  // Explicit cross-layer links still use Add step; it is not a call browser.
  await frame.locator('#add').click();
  const search=frame.getByPlaceholder('Symbol, filename or text…');
  await search.fill('submit');
  await frame.locator('.choice').first().waitFor();
  assert.equal(await frame.locator('.choice').count(),1);
  await frame.getByRole('button',{name:'Close',exact:true}).click();
  // The built-in TS definition provider must resolve an imported alias that the
  // name fallback cannot resolve; no function-wide candidate picker is involved.
  await frame.locator('.code-card').first().locator('[data-source-name="storeOrder"]').last().click({modifiers:[process.platform==='darwin'?'Meta':'Control']});
  await frame.locator('.code-card').nth(2).waitFor();
  await frame.locator('.code-card').nth(1).locator('.filename').filter({hasText:'store.ts'}).waitFor();
  assert.equal(await frame.getByText('Source-linked',{exact:true}).count(),0);
  assert.equal(await frame.locator('.code-card').nth(1).locator('.reason .badge').count(),0);
  await frame.locator('.code-card').nth(1).getByText('No code explanation yet.',{exact:true}).waitFor();
  const aliasWalkId=await frame.locator('#paths button.selected').getAttribute('data-path');
  const aliasWalk=await callTool(root,'get_walkthrough',{id:aliasWalkId});
  assert.equal(aliasWalk.steps[1].evidence,'source','Definition evidence stays in metadata, not a jargon badge.');
  await frame.getByRole('button',{name:'Open in editor ↗',exact:true}).first().click();
  await delay(800);
  assert.equal(await frame.locator('#error').isVisible(),false);
  fs.writeFileSync(path.join(dir,'ui-done.json'),'{}');
  for(let i=0;!fs.existsSync(path.join(dir,'go-ready.json'))&&i<200;i++)await delay(100);
  assert.ok(fs.existsSync(path.join(dir,'go-ready.json')),'Go cursor-start tests must become ready.\n'+logs);
  const goStart=JSON.parse(fs.readFileSync(path.join(dir,'go-ready.json'),'utf8'));
  await frame.locator('[data-step="'+goStart.stepId+'"]').waitFor();
  await frame.getByRole('heading',{name:'Explore main.go · lines '+goStart.line+'–'+goStart.line,exact:true}).waitFor();
  assert.equal(await frame.locator('.code-card').count(),1);
  assert.equal(await frame.locator('.line.focus').count(),1);
  assert.match(await frame.locator('.line.focus').innerText(),/http\.HandleFunc\("\/api\/orders",\s*handleOrder\)/);
  const callback=frame.locator('.line.focus [data-source-name="handleOrder"]');
  await callback.click({button:'right'});
  await frame.getByRole('menuitem',{name:'Follow definition of handleOrder',exact:true}).click();
  await frame.locator('.code-card').nth(1).locator('.filename').filter({hasText:'go/handler.go'}).waitFor();
  assert.equal(await frame.locator('.code-card').count(),2);
  assert.equal(await frame.locator('#modal').isVisible(),false);
  assert.equal(await frame.locator('#error').isVisible(),false);
  fs.writeFileSync(path.join(dir,'go-done.json'),'{}');
  for(let i=0;!fs.existsSync(path.join(dir,'delete-ready'))&&i<200;i++)await delay(100);
  assert.ok(fs.existsSync(path.join(dir,'delete-ready')),'Go assertions must finish before deletion.');
  const mainBefore=fs.readFileSync(path.join(root,'go/main.go'),'utf8');
  await callTool(root,'add_note',{walkthroughId:goStart.walkthroughId,stepId:goStart.stepId,body:'Delete this note.',author:'UI test'});
  const savedRun=await callTool(root,'record_run',{walkthroughId:goStart.walkthroughId,label:'Delete this fixture',mode:'example',origin:'UI test fixture',events:[]});
  await frame.locator('#delete-path').click({timeout:3000});
  await frame.getByText('1 note',{exact:false}).waitFor();
  await frame.getByText('1 saved run',{exact:false}).waitFor();
  await frame.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal((await callTool(root,'get_walkthrough',{id:goStart.walkthroughId})).steps.length,2);
  await frame.locator('#delete-path').click();
  // Clicking Delete only starts asynchronous snapshot loading. Wait until the
  // confirmation is actually open before introducing concurrent agent work.
  await frame.locator('#confirm-delete').waitFor({state:'visible'});
  await frame.locator('#modal').getByText('1 note',{exact:false}).waitFor();
  // New agent work after confirmation must force a fresh review, not disappear.
  await callTool(root,'add_note',{walkthroughId:goStart.walkthroughId,stepId:goStart.stepId,body:'Arrived after confirmation.',author:'Agent'});
  await frame.locator('#confirm-delete').click();
  await frame.locator('#modal-error').filter({hasText:'Walkthrough changed'}).waitFor();
  assert.equal(await frame.locator('#confirm-delete').isDisabled(),true);
  assert.equal((await callTool(root,'get_walkthrough',{id:goStart.walkthroughId})).steps[0].notes.length,2);
  await frame.getByRole('button',{name:'Review latest',exact:true}).click();
  await frame.getByText('2 notes',{exact:false}).waitFor();
  await frame.locator('#confirm-delete').click();
  await frame.locator('#paths [data-path="'+goStart.walkthroughId+'"]').waitFor({state:'detached'});
  await assert.rejects(callTool(root,'get_walkthrough',{id:goStart.walkthroughId}),/not found/);
  await assert.rejects(callTool(root,'get_run',{id:savedRun.id}),/not found/);
  assert.equal(fs.readFileSync(path.join(root,'go/main.go'),'utf8'),mainBefore);
  // Simulate another client deleting the active path; polling must recover.
  const activeId=await frame.locator('#paths button.selected').getAttribute('data-path');
  const activePath=await callTool(root,'get_walkthrough',{id:activeId});
  await callTool(root,'delete_walkthrough',{id:activeId,expectedRevision:activePath.revision});
  await frame.locator('#paths [data-path="'+activeId+'"]').waitFor({state:'detached'});
  assert.equal(await frame.locator('#error').isVisible(),false);
  // Delete the remaining paths through the actual confirmation dialog.
  let remaining=(await callTool(root,'project_overview')).paths.length;
  while(remaining){
    await frame.locator('#delete-path').click();
    await frame.locator('#confirm-delete').click();
    remaining--;
    await frame.waitForFunction(count=>document.querySelectorAll('#paths [data-path]').length===count,remaining);
  }
  await frame.getByRole('heading',{name:'Your source is ready.',exact:true}).waitFor();
  assert.equal(await frame.locator('#delete-path').isVisible(),false);
  assert.equal(await frame.locator('#add').isDisabled(),true);
  assert.equal(await frame.locator('#detail').isVisible(),false);
  assert.equal(await frame.locator('#error').isVisible(),false);
  fs.writeFileSync(path.join(dir,'delete-done'),'passed');
  for(let i=0;!fs.existsSync(path.join(dir,'reopen-ready'))&&i<200;i++)await delay(100);
  assert.ok(fs.existsSync(path.join(dir,'reopen-ready')));
  let reopened;
  for(let i=0;!reopened&&i<100;i++){
    // Closing/reopening disposes the old webview's execution context. A count()
    // on that outgoing frame can wait past the host's reopen handshake deadline.
    for(const page of browser.contexts().flatMap(c=>c.pages()))for(const candidate of page.frames()){
      try{
        await candidate.locator('.welcome').waitFor({state:'visible',timeout:500});
        reopened=candidate;
        break;
      }catch(e){
        if(e.name!=='TimeoutError'&&!candidate.isDetached())throw e;
      }
    }
    if(!reopened)await delay(100);
  }
  assert.ok(reopened,'A reopened panel must render the empty workspace.');
  assert.equal(await reopened.locator('#paths [data-path]').count(),0);
  assert.equal(await reopened.locator('#error').isVisible(),false);
  fs.writeFileSync(path.join(dir,'reopen-done'),'passed');
  const timeout=new AbortController();
  let code;
  try{code=await Promise.race([exited,delay(30000,null,{signal:timeout.signal}).then(()=>{throw Error('VS Code did not finish its tests.');})]);}
  finally{timeout.abort();}
  assert.equal(code,0,logs);
  assert.ok(fs.existsSync(path.join(dir,'host-passed')),logs);
  console.log('VS Code integration passed: line-based cursor starts, TS alias definition lookup, Go HandleFunc/handleOrder starts, right-click callback navigation, no Browse calls control, explicit Add step, notes, source navigation, cancellation, revision-safe deletion, external deletion, empty-state reopening and cleanup.');
}catch(e){
  fs.writeFileSync(path.join(dir,'ui-done.json'),JSON.stringify({error:e.message}));
  if(frameForDiagnostics){
    console.error('Codepath UI:',await frameForDiagnostics.locator('#error').innerText().catch(()=>''));
    console.error('Codepath cards:',await frameForDiagnostics.locator('.code-card .filename').allTextContents().catch(()=>[]));
    console.error('Codepath note controls:',await frameForDiagnostics.locator('#notes-panel').innerText().catch(()=>''));
    console.error('Codepath editor count:',await frameForDiagnostics.locator('.annotation-editor').count().catch(()=>-1));
  }
  const logRoot=path.join(dir,'profile/logs');
  if(fs.existsSync(logRoot))for(const file of fs.readdirSync(logRoot,{recursive:true})){
    if(String(file).endsWith('-Codepath.log'))console.error(fs.readFileSync(path.join(logRoot,file),'utf8'));
  }
  const saved=path.join(root,'.codepaths/workspace.json');
  if(fs.existsSync(saved))console.error('Saved steps:',JSON.parse(fs.readFileSync(saved,'utf8')).paths.map(p=>({id:p.id,steps:p.steps.map(s=>s.source)})));
  console.error(logs);throw e;
}finally{
  await browser?.close().catch(()=>{});
  if(child.exitCode===null)child.kill('SIGTERM');
  await exited.catch(()=>{});
  fs.rmSync(dir,{recursive:true,force:true});
}
