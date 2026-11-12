import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { sha256 } from "./tlc.mjs";

const compact = (text) => text.replace(/\s+/g, "");
function parse(file, text) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, `${file} must parse.`);
  return tree;
}
function nodes(tree, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
function one(tree, predicate, message) {
  const found = nodes(tree, predicate);
  assert.equal(found.length, 1, message);
  return found[0];
}
function ordered(text, fragments, message) {
  const positions = fragments.map((fragment) => text.indexOf(fragment));
  assert.ok(
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || positions[index - 1] < position)
    ),
    message
  );
}
function declaration(tree, name) {
  return one(
    tree,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    `Review ${name}.`
  );
}
function variable(tree, name) {
  return one(
    tree,
    (node) => ts.isVariableDeclaration(node) && node.name.getText() === name,
    `Review ${name}.`
  );
}
function statement(node) {
  while (!ts.isStatement(node)) node = node.parent;
  return node;
}
function tokenCondition(helper) {
  return one(
    helper,
    (node) =>
      ts.isIfStatement(node) &&
      compact(node.thenStatement.getText(helper)) ===
        "fs.unlinkSync(connection);",
    "Review the helper's token-guarded connection cleanup."
  ).expression;
}
function acquisition(helper) {
  return one(
    helper,
    (node) =>
      ts.isAwaitExpression(node) &&
      (node.expression.getText(helper).includes("reservation.listen(") ||
        compact(node.expression.getText(helper)) === "Promise.resolve()"),
    "Review the reservation acquisition await."
  );
}

export function reviewedSource(projectRoot) {
  const record = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, "formal/service-ownership/coverage.json"),
      "utf8"
    )
  );
  const sources = {};
  for (const entry of record.sources) {
    const bytes = fs.readFileSync(path.join(projectRoot, entry.file));
    assert.equal(
      sha256(bytes),
      entry.sha256,
      `${entry.file} changed after model review. Review correspondence before updating its hash.`
    );
    sources[entry.file] = bytes.toString();
  }
  assert.deepEqual(Object.keys(sources).sort(), [
    "service-ownership.mts",
    "service.mts",
    "workspace.mts",
  ]);
  sourceCorrespondence(sources);
  return sources;
}

export function sourceCorrespondence(sources) {
  const service = parse("service.mts", sources["service.mts"]);
  const helper = parse(
    "service-ownership.mts",
    sources["service-ownership.mts"]
  );
  const workspace = parse("workspace.mts", sources["workspace.mts"]);
  const start = declaration(service, "startProjectService");
  const claim = variable(start, "claim");
  assert.equal(
    compact(claim.initializer.getText(service)),
    "awaitclaimProjectService(root,reuse)"
  );
  const snapshot = variable(start, "workspace");
  assert.equal(
    compact(snapshot.initializer.getText(service)),
    "openWorkspace(root)"
  );
  const fresh = snapshot.pos > claim.pos;
  assert.equal(
    statement(snapshot).parent.kind,
    fresh ? ts.SyntaxKind.Block : start.body.kind
  );
  if (fresh)
    assert.ok(
      ts.isTryStatement(statement(snapshot).parent.parent),
      "Fresh workspace must remain in owner startup's try block."
    );
  else
    assert.equal(
      statement(snapshot).parent,
      start.body,
      "The premature-snapshot mutant must load before claim in the outer body."
    );
  const ownerClaim = declaration(helper, "claimProjectService");
  const bind = acquisition(helper);
  const exclusive =
    compact(bind.expression.getText(helper)) !== "Promise.resolve()";
  if (exclusive) {
    const listen = one(
      bind,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(helper) === "reservation.listen",
      "Review exclusive reservation listen."
    );
    assert.equal(
      compact(listen.arguments[0].getText(helper)),
      '{host:"127.0.0.1",port:reservationPort,exclusive:true}'
    );
    assert.ok(
      bind.getText(helper).includes('reservation.once("error", reject)')
    );
  }
  const release = declaration(helper, "release");
  if (exclusive)
    assert.ok(release.getText(helper).includes("reservation.close("));
  else
    assert.equal(
      compact(release.body.getText(helper)),
      "{returnPromise.resolve();}",
      "No-op reservation must also release its unbound server safely."
    );
  const discoverCalls = nodes(
    ownerClaim,
    (node) =>
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(helper) === "discover"
  );
  assert.equal(
    discoverCalls.length,
    2,
    "Review discovery before and after reservation."
  );
  assert.ok(discoverCalls[0].pos < bind.pos && bind.pos < discoverCalls[1].pos);
  const discover = declaration(helper, "discover");
  ordered(
    compact(discover.getText(helper)),
    [
      "awaitfetch(",
      "if(!same(snapshot,readConnection(root)))continue;",
      "if(healthy)return{snapshot,active:c};",
      "if(!dead(c.pid))throwError(",
    ],
    "Discovery must reread identity after the probe, before PID liveness interpretation."
  );
  const token = tokenCondition(helper);
  const tokenText = compact(token.getText(helper));
  assert.ok(
    ["true", "parse(readConnection(root))?.token===token"].includes(tokenText),
    "Review the helper token identity comparison."
  );
  const close = one(
    helper,
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText(helper) === "close",
    "Review claim close."
  );
  const closeText = compact(close.getText(helper));
  ordered(
    closeText,
    [
      "if(closing)returnclosing;",
      'phase="closing"',
      "awaitstopAndDrain()",
      "fs.unlinkSync(connection)",
      "awaitrelease(reservation)",
      'phase="closed"',
    ],
    "Close must fence admission, drain, token-clean, then release last."
  );
  const writable = one(
    helper,
    (node) =>
      ts.isMethodDeclaration(node) &&
      node.name.getText(helper) === "assertWritable",
    "Review published-phase write admission."
  );
  assert.ok(
    compact(writable.getText(helper)).includes(
      'if(phase!=="published")throwError('
    )
  );
  const stop = declaration(service, "stopAndDrain");
  ordered(
    compact(stop.getText(service)),
    [
      "server!.close(",
      "for(constsocketofsockets)socket.destroy();",
      "awaitPromise.allSettled([",
      "while(handlers.size)awaitPromise.all([...handlers]);",
    ],
    "Drain must stop HTTP, destroy incomplete sockets, and await every handler."
  );
  const serviceText = compact(start.getText(service));
  assert.ok(serviceText.includes("handlers.add(pending);"));
  assert.ok(serviceText.includes("handlers.delete(pending)"));
  const invoke = one(
    service,
    (node) =>
      ts.isReturnStatement(node) &&
      compact(node.getText(service)) ===
        "returnjson(res,200,workspace.invoke(a.name,a.arguments));",
    "Review the synchronous generic tool mutation."
  );
  const siblings = invoke.parent.statements;
  assert.equal(
    compact(siblings[siblings.indexOf(invoke) - 1].getText(service)),
    "owner.assertWritable();"
  );
  const comparisonWrite = one(
    service,
    (node) =>
      ts.isReturnStatement(node) &&
      compact(node.getText(service)) ===
        "returnjson(res,200,workspace.saveComparisonNote(view,a.arguments));",
    "Review post-Git comparison annotation mutation."
  );
  const comparisonSiblings = comparisonWrite.parent.statements;
  const comparisonPosition = comparisonSiblings.indexOf(comparisonWrite);
  assert.equal(
    compact(comparisonSiblings[comparisonPosition - 1].getText(service)),
    "owner.assertWritable();",
    "Every persistent comparison write needs immediate post-await owner admission."
  );
  assert.ok(
    compact(
      comparisonSiblings[comparisonPosition - 2].getText(service)
    ).includes("awaitgit!.file("),
    "Validate the exact comparison before owner admission, without cloning workspace state before that await."
  );
  assert.ok(
    compact(stop.getText(service)).includes("git?.close(),"),
    "Drain owned Git jobs as well as HTTP handlers before ownership release."
  );
  const comparisonCommit = declaration(workspace, "commitComparisonNotes");
  assert.equal(nodes(comparisonCommit, ts.isAwaitExpression).length, 0);
  const comparisonMethod = one(
    workspace,
    (node) =>
      ts.isMethodDeclaration(node) &&
      node.name.getText(workspace) === "saveComparisonNote",
    "Review synchronous comparison note commit method."
  );
  assert.equal(nodes(comparisonMethod, ts.isAwaitExpression).length, 0);
  // Source-bound writes add Git awaits, not a new persisted-state writer.
  // Keep each admission immediately adjacent to its current-state sync commit.
  for (const [method, admission] of [
    ["createComparisonWalkthrough", "awaitgit!.admit("],
    ["saveWalkthroughComparisonNote", "awaitgit!.fresh("],
    ["setGitViewed", "awaitgit!.admitViewed("],
  ]) {
    const write = one(
      service,
      (node) =>
        ts.isReturnStatement(node) &&
        compact(node.getText(service)).startsWith(
          `returnjson(res,200,workspace.${method}(`
        ),
      `Review post-Git authored comparison mutation: ${method}.`
    );
    const statements = write.parent.statements;
    const position = statements.indexOf(write);
    assert.equal(
      compact(statements[position - 1].getText(service)),
      "owner.assertWritable();",
      `${method} must re-admit ownership immediately after all Git awaits.`
    );
    assert.ok(
      compact(statements[position - 2].getText(service)).includes(admission),
      `${method} must receive the freshly admitted source before the owner fence.`
    );
    const commit = one(
      workspace,
      (node) =>
        ts.isMethodDeclaration(node) && node.name.getText(workspace) === method,
      `Review synchronous authored comparison method: ${method}.`
    );
    assert.equal(nodes(commit, ts.isAwaitExpression).length, 0);
  }
  const viewedCommit = declaration(workspace, "commitGitViewed");
  assert.equal(nodes(viewedCommit, ts.isAwaitExpression).length, 0);
  assert.ok(
    compact(viewedCommit.getText(workspace)).includes(
      "changeGitViewed(state.gitViewed,input,viewed)"
    ),
    "Viewed CAS must use CURRENT workspace state, not a pre-await clone."
  );
  const authoredNotesCommit = declaration(workspace, "commitWalkthroughNotes");
  assert.equal(nodes(authoredNotesCommit, ts.isAwaitExpression).length, 0);
  const listenAwait = one(
    service,
    (node) =>
      ts.isAwaitExpression(node) &&
      node.getText(service).includes("listener.listen("),
    "Review HTTP readiness await."
  );
  const publish = one(
    service,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(service) === "claim.publish",
    "Review publication."
  );
  assert.ok(listenAwait.pos < publish.pos);
  const publishMethod = one(
    helper,
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText(helper) === "publish",
    "Review atomic connection publication."
  );
  assert.equal(
    nodes(
      publishMethod,
      (node) =>
        ts.isCallExpression(node) && node.expression.getText(helper) === "same"
    ).length,
    2
  );
  ordered(
    compact(publishMethod.getText(helper)),
    [
      "if(!same(expected,readConnection(root)))",
      "fs.openSync(",
      "fs.writeFileSync(",
      "fs.closeSync(descriptor)",
      "descriptor=undefined;",
      'throwError("Connectionchangedduringpublication;refusingreplacement.");',
      "fs.renameSync(temporary,connection)",
      'phase="published"',
    ],
    "Publication must check identity before the final atomic rename."
  );
  const save = variable(workspace, "save");
  assert.equal(nodes(save, ts.isAwaitExpression).length, 0);
  assert.ok(save.getText(workspace).includes("fs.renameSync(tmp, file)"));
  const workspaceInvoke = nodes(
    workspace,
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "invoke" &&
      node.body
  )[0];
  assert.ok(
    workspaceInvoke.getText(workspace).includes('name === "save_walkthrough"')
  );
  assert.equal(nodes(workspaceInvoke, ts.isAwaitExpression).length, 0);
  return {
    ExclusiveReservation: exclusive,
    FreshSnapshot: fresh,
    RequireOwnerToken: tokenText !== "true",
  };
}

function replace(text, edits) {
  for (const { start, end, text: value } of edits.sort(
    (a, b) => b.start - a.start
  ))
    text = text.slice(0, start) + value + text.slice(end);
  return text;
}
export function mutateSource(sources, mutation) {
  const changed = { ...sources };
  const flags = sourceCorrespondence(sources);
  assert.ok(
    Object.values(flags).every(Boolean),
    "Mutate only the reviewed fixed source."
  );
  if (mutation === "no-op-reservation") {
    const helper = parse(
      "service-ownership.mts",
      sources["service-ownership.mts"]
    );
    const bind = acquisition(helper),
      release = declaration(helper, "release");
    changed["service-ownership.mts"] = replace(
      sources["service-ownership.mts"],
      [
        {
          start: bind.getStart(helper),
          end: bind.end,
          text: "await Promise.resolve()",
        },
        {
          start: release.body.getStart(helper),
          end: release.body.end,
          text: "{ return Promise.resolve(); }",
        },
      ]
    );
  } else if (mutation === "premature-snapshot") {
    const service = parse("service.mts", sources["service.mts"]);
    const start = declaration(service, "startProjectService");
    const snapshot = statement(variable(start, "workspace"));
    const claim = statement(variable(start, "claim"));
    changed["service.mts"] = replace(sources["service.mts"], [
      { start: snapshot.getStart(service), end: snapshot.end, text: "" },
      {
        start: claim.getStart(service),
        end: claim.getStart(service),
        text: snapshot.getText(service) + "\n  ",
      },
    ]);
  } else if (mutation === "removed-token-guard") {
    const helper = parse(
      "service-ownership.mts",
      sources["service-ownership.mts"]
    );
    const token = tokenCondition(helper);
    changed["service-ownership.mts"] = replace(
      sources["service-ownership.mts"],
      [{ start: token.getStart(helper), end: token.end, text: "true" }]
    );
  } else throw Error(`Unknown mutation ${mutation}`);
  sourceCorrespondence(changed);
  return changed;
}
