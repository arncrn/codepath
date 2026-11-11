const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.run=async()=>{
  const testDir=process.env.CODEPATH_TEST_DIR;
  assert.ok(testDir,'Use npm run test:vscode to launch an isolated test workspace.');
  const extension=vscode.extensions.getExtension('codepath-local.codepath-prototype');
  assert.ok(extension,'Extension must be discovered.');
  await extension.activate();
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'flow.ts')));
  let editor=await vscode.window.showTextDocument(doc);
  editor.selection=new vscode.Selection(1,2,1,2);
  const cursorWalk=await vscode.commands.executeCommand('codepath.startFromSelection');
  assert.ok(cursorWalk?.walkthroughId,'Cursor command creates a walkthrough.');
  const connection=JSON.parse(fs.readFileSync(path.join(root,'.codepaths/connection.json'),'utf8'));
  async function call(name,args){
    const response=await fetch('http://127.0.0.1:'+connection.port+'/api/call',{
      method:'POST',headers:{'Content-Type':'application/json','X-Codepath-Token':connection.token},body:JSON.stringify({name,arguments:args})
    });
    assert.equal(response.status,200);return response.json();
  }
  const first=await call('get_walkthrough',{id:cursorWalk.walkthroughId});
  assert.equal(first.steps[0].source.startLine,2);
  assert.equal(first.steps[0].source.endLine,2);
  editor=await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
  editor.selection=new vscode.Selection(1,0,2,0); // Exclusive end must not include line 3.
  const rangeWalk=await vscode.commands.executeCommand('codepath.startFromSelection');
  const second=await call('get_walkthrough',{id:rangeWalk.walkthroughId});
  assert.equal(second.steps[0].source.startLine,2);
  assert.equal(second.steps[0].source.endLine,2);
  editor=await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
  editor.selection=new vscode.Selection(4,0,5,0); // A call outside any function.
  const selectedWalk=await vscode.commands.executeCommand('codepath.startFromSelection');
  const topLevel=await call('get_walkthrough',{id:selectedWalk.walkthroughId});
  assert.equal(topLevel.steps[0].source.startLine,5);
  assert.equal(topLevel.steps[0].source.endLine,5);
  await vscode.commands.executeCommand('codepath.open');
  fs.writeFileSync(path.join(testDir,'host-ready.json'),JSON.stringify({root,...selectedWalk}));
  let maximizedForAuthoring=false;
  for(let i=0;!fs.existsSync(path.join(testDir,'ui-done.json'))&&i<1200;i++){
    if(!maximizedForAuthoring&&fs.existsSync(path.join(testDir,'authoring-maximize'))){
      await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
      maximizedForAuthoring=true;
    }
    await delay(100);
  }
  assert.ok(fs.existsSync(path.join(testDir,'ui-done.json')),'Webview UI tests must finish.');
  const uiResult=JSON.parse(fs.readFileSync(path.join(testDir,'ui-done.json'),'utf8'));
  assert.ok(!uiResult.error,uiResult.error);
  const active=vscode.window.activeTextEditor;
  assert.equal(active.document.uri.fsPath,doc.uri.fsPath,'Open in editor focuses the original source.');
  assert.equal(active.selection.start.line,4);
  assert.equal(active.selection.end.line,4);
  const completed=await call('get_walkthrough',{id:selectedWalk.walkthroughId});
  assert.equal(completed.steps[0].notes[0].body,'Edited from the native webview.');
  assert.ok(completed.steps[0].notes[0].history.some(version=>version.body==='Note from the VS Code webview.'));
  assert.equal(completed.steps[1].source.file,'store.ts');
  assert.equal(completed.steps[1].source.symbol,'persist');
  assert.equal(completed.steps[1].evidence,'source');
  // Reproduce both of the user's Go right-click entry points with no selection.
  const goDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'go/main.go')));
  const registrationLine=goDoc.getText().split('\n').findIndex(line=>line.includes('http.HandleFunc('));
  assert.ok(registrationLine>=0,'The fixture must contain the route registration.');
  let goWalk;
  for(const word of ['HandleFunc','handleOrder']){
    const goEditor=await vscode.window.showTextDocument(goDoc,vscode.ViewColumn.One);
    const column=goDoc.lineAt(registrationLine).text.indexOf(word)+2;
    goEditor.selection=new vscode.Selection(registrationLine,column,registrationLine,column);
    goWalk=await vscode.commands.executeCommand('codepath.startFromSelection');
    const created=await call('get_walkthrough',{id:goWalk.walkthroughId});
    assert.equal(created.steps[0].source.startLine,registrationLine+1);
    assert.equal(created.steps[0].source.endLine,registrationLine+1);
    assert.equal(created.steps[0].source.symbol,undefined);
  }
  fs.writeFileSync(path.join(testDir,'go-ready.json'),JSON.stringify({...goWalk,line:registrationLine+1}));
  for(let i=0;!fs.existsSync(path.join(testDir,'go-done.json'))&&i<600;i++)await delay(100);
  assert.ok(fs.existsSync(path.join(testDir,'go-done.json')),'Go context-menu test must finish.');
  const goPath=await call('get_walkthrough',{id:goWalk.walkthroughId});
  assert.equal(goPath.steps.length,2);
  assert.equal(goPath.steps[1].source.file,'go/handler.go');
  assert.equal(goPath.steps[1].source.symbol,'handleOrder');
  assert.equal(goPath.steps[1].evidence,'inferred'); // Isolated host has no Go extension.
  fs.writeFileSync(path.join(testDir,'delete-ready'),'ready');
  for(let i=0;!fs.existsSync(path.join(testDir,'delete-done'))&&i<600;i++)await delay(100);
  assert.ok(fs.existsSync(path.join(testDir,'delete-done')),'Deletion UI tests must finish.');
  const empty=await call('project_overview',{});
  assert.deepEqual(empty.paths,[]);
  assert.deepEqual(empty.runs,[]);
  assert.equal(empty.focus,null);
  assert.equal(fs.readFileSync(doc.uri.fsPath,'utf8'),doc.getText(),'Deleting walkthroughs never changes source.');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.commands.executeCommand('codepath.open');
  fs.writeFileSync(path.join(testDir,'reopen-ready'),'ready');
  for(let i=0;!fs.existsSync(path.join(testDir,'reopen-done'))&&i<200;i++)await delay(100);
  assert.ok(fs.existsSync(path.join(testDir,'reopen-done')),'Reopened empty panel must be verified.');
  const {deactivate}=require(path.join(extension.extensionPath,'dist/extension.cjs'));
  await deactivate();
  assert.equal(fs.existsSync(path.join(root,'.codepaths/connection.json')),false,'Deactivation removes the owned connection.');
  fs.writeFileSync(path.join(testDir,'host-passed'),'passed');
  console.log('Codepath VS Code host tests passed.');
};
