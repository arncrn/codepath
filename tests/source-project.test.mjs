import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSourceProject } from "../dist/source-project.mjs";
import { openWorkspace } from "../dist/workspace.mjs";
import { startProjectService } from "../dist/service.mjs";
import { followReference } from "../dist/vscode/definition.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-source-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
function write(root, file, text = "export function run() { return 1; }\n") {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function collect(call, field) {
  let cursor,
    pages = 0;
  const results = [];
  do {
    const page = call(cursor);
    results.push(...page[field]);
    assert.equal(page.complete, !page.nextCursor);
    cursor = page.nextCursor;
    assert.ok(++pages < 1000, "continuation must eventually finish");
  } while (cursor);
  return results;
}

test("Known source beyond 200 files and 5,000 entries is usable without finishing discovery", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 1200; i++) write(root, `a-source/file-${i}.ts`);
  for (let i = 1; i < 20; i++)
    write(
      root,
      `z-relevant/step-${i}.ts`,
      `export function step${i}() { return ${i}; }\n`
    );
  for (let i = 0; i < 5100; i++) write(root, `b-assets/file-${i}.json`, "{}");
  write(
    root,
    "z-target/target.ts",
    "export function target() { return next(); }\nexport function next() { return 42; }\n"
  );
  write(root, "broken/huge.ts", "x".repeat(1048577));
  const workspace = openWorkspace(root);
  assert.equal(workspace.overview().index.discoveryComplete, false);
  assert.match(
    workspace.invoke("read_source", { file: "z-target/target.ts" }).text,
    /return 42/
  );
  const walk = workspace.invoke("save_walkthrough", {
    title: "Only my target",
    steps: [
      {
        id: "target",
        title: "Target",
        source: { file: "z-target/target.ts", symbol: "target" },
      },
      ...Array.from({ length: 19 }, (_, i) => ({
        id: "step" + (i + 1),
        title: "Relevant " + (i + 1),
        source: {
          file: `z-relevant/step-${i + 1}.ts`,
          symbol: "step" + (i + 1),
        },
      })),
    ],
  });
  assert.equal(walk.steps.length, 20);
  assert.ok(
    walk.steps.every((step) => step.code && !step.stale && !step.error)
  );
  assert.match(walk.steps[0].code.excerpt, /next/);
  const calls = collect(
    (cursor) =>
      workspace.invoke("follow_calls", {
        source: walk.steps[0].source,
        cursor,
      }),
    "candidates"
  );
  assert.ok(
    calls.some((s) => s.name === "next" && s.file === "z-target/target.ts")
  );
  const files = collect(
    (cursor) => workspace.invoke("list_source_files", { cursor }),
    "files"
  );
  assert.equal(files.length, 1220);
  assert.ok(files.some((f) => f.file === "z-target/target.ts"));
  const symbols = collect(
    (cursor) => workspace.invoke("find_symbols", { query: "target", cursor }),
    "symbols"
  );
  assert.ok(symbols.some((s) => s.name === "target"));
  const hits = collect(
    (cursor) =>
      workspace.invoke("search_source", { query: "return 42", cursor }),
    "hits"
  );
  assert.equal(hits.length, 1);
});

test("Overview never reads/parses source; unchanged inspections reuse results and cache eviction does not restrict eligibility", (t) => {
  const root = fixture(t);
  for (const file of ["a.ts", "b.ts", "c.ts"]) write(root, file);
  const originalRead = fs.readFileSync;
  const sourceReads = [];
  t.mock.method(fs, "readFileSync", function (file, ...rest) {
    if (String(file).startsWith(root) && String(file).endsWith(".ts"))
      sourceReads.push(String(file));
    return originalRead.call(this, file, ...rest);
  });
  const project = createSourceProject(root, { cacheFiles: 2 });
  for (let i = 0; i < 3; i++) {
    project.refresh();
    JSON.stringify(project.snapshot());
  }
  assert.deepEqual(sourceReads, []);
  const first = project.inspect("a.ts");
  assert.strictEqual(project.inspect("a.ts"), first);
  assert.equal(sourceReads.length, 1);
  const before = project.snapshot().version;
  project.inspect("b.ts");
  project.inspect("c.ts");
  const after = project.snapshot().version;
  assert.notStrictEqual(project.inspect("a.ts"), first);
  assert.equal(
    project.snapshot().version,
    after,
    "cache eviction is not a source change"
  );
  assert.notEqual(
    before,
    after,
    "first inspection can supply new content fingerprints"
  );
  assert.equal(project.inspect("a.ts").hash, first.hash);
});

test("Changed, renamed, deleted and newly excluded source cannot survive as successful cached reads", (t) => {
  const root = fixture(t);
  write(root, "flow.ts");
  const project = createSourceProject(root),
    first = project.inspect("flow.ts");
  write(root, "flow.ts", "export function run() { return 9; }\n");
  assert.notEqual(project.inspect("flow.ts").hash, first.hash);
  fs.renameSync(path.join(root, "flow.ts"), path.join(root, "renamed.ts"));
  assert.throws(() => project.inspect("flow.ts"), /ENOENT/);
  assert.equal(project.inspect("renamed.ts").symbols[0].name, "run");
  write(root, ".codepaths-ignore", "renamed.ts\n");
  assert.throws(() => project.inspect("renamed.ts"), /excluded/);
  write(root, ".codepaths-ignore", "# no exclusions\n");
  assert.equal(project.inspect("renamed.ts").symbols[0].name, "run");
  fs.unlinkSync(path.join(root, "renamed.ts"));
  assert.throws(() => project.inspect("renamed.ts"), /ENOENT/);
});

test("Current source hashes fence explanation writes even if filesystem metadata appears unchanged", (t) => {
  const root = fixture(t),
    file = path.join(root, "flow.ts");
  write(root, "flow.ts");
  const workspace = openWorkspace(root);
  const walk = workspace.invoke("save_walkthrough", {
    title: "Current",
    steps: [
      { id: "run", title: "Run", source: { file: "flow.ts", symbol: "run" } },
    ],
  });
  const oldBig = fs.statSync(file, { bigint: true }),
    old = fs.statSync(file);
  write(root, "flow.ts", "export function run() { return 9; }\n");
  const original = fs.statSync;
  t.mock.method(fs, "statSync", function (target, options) {
    return target === file
      ? options?.bigint
        ? oldBig
        : old
      : original.call(this, target, options);
  });
  const disk = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  assert.equal(
    workspace.invoke("get_walkthrough", { id: walk.id }).steps[0].stale,
    true
  );
  assert.throws(
    () =>
      workspace.invoke("review_explanation", {
        walkthroughId: walk.id,
        stepId: "run",
        expectedRevision: walk.revision,
        sourceHash: walk.steps[0].code.hash,
        fileHash: walk.steps[0].code.fileHash,
        body: "Returns 1",
        author: "Test",
        attachments: [],
      }),
    /changed/i
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    disk
  );
});

test("Direct source access preserves exclusions, dependency, hidden, size, symlink and root containment restrictions", (t) => {
  const root = fixture(t);
  write(root, "flow.ts");
  write(root, "ignored/file.ts");
  write(root, "node_modules/file.ts");
  write(root, ".hidden/file.ts");
  write(root, "huge.ts", "x".repeat(1048577));
  write(root, "types.d.ts");
  write(root, ".codepaths-ignore", "ignored\n");
  fs.symlinkSync(path.join(root, "flow.ts"), path.join(root, "alias.ts"));
  const project = createSourceProject(root);
  for (const file of [
    "../outside.ts",
    "ignored/file.ts",
    "node_modules/file.ts",
    "NODE_MODULES/file.ts",
    "IGNORED/file.ts",
    ".hidden/file.ts",
    "huge.ts",
    "alias.ts",
    "types.d.ts",
  ])
    assert.throws(() => project.inspect(file));
  assert.equal(project.inspect("flow.ts").symbols[0].name, "run");
});

test("Search pages can continue within one file without dropping hits, and cursors cannot cross queries or changed exclusions", (t) => {
  const root = fixture(t);
  write(
    root,
    "flow.ts",
    Array.from({ length: 250 }, (_, i) => `// needle ${i}`).join("\n")
  );
  const project = createSourceProject(root);
  const hits = collect((cursor) => project.search("needle", cursor), "hits");
  assert.equal(hits.length, 250);
  assert.equal(new Set(hits.map((hit) => hit.line)).size, 250);
  const page = project.search("needle");
  assert.ok(page.nextCursor);
  assert.throws(
    () => project.search("different", page.nextCursor),
    /expired or changed/
  );
  write(root, ".codepaths-ignore", "flow.ts\n");
  assert.throws(
    () => project.search("needle", page.nextCursor),
    /expired or changed/
  );
});

test("Paged call searches retain matched names across empty continuation pages before reporting unresolved calls", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 260; i++)
    write(
      root,
      `a-callees/file-${i}.ts`,
      "export function target() { return 1; }\n"
    );
  for (let i = 0; i < 600; i++) write(root, `y-assets/file-${i}.json`, "{}");
  write(
    root,
    "z-caller.ts",
    "export function caller() { return target() + missing(); }\n"
  );
  const workspace = openWorkspace(root);
  let cursor,
    last,
    count = 0;
  do {
    last = workspace.invoke("follow_calls", {
      source: { file: "z-caller.ts", symbol: "caller" },
      cursor,
    });
    count += last.candidates.length;
    cursor = last.nextCursor;
    if (cursor) {
      assert.equal(last.unresolvedComplete, false);
      assert.deepEqual(last.unresolved, []);
    }
  } while (cursor);
  assert.equal(count, 260);
  assert.equal(last.unresolvedComplete, true);
  assert.deepEqual(
    last.unresolved.map((call) => call.name),
    ["missing"]
  );
});

test("Reader-scoped metadata checks survive another client reading a different walkthrough", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 5100; i++) write(root, `a-assets/file-${i}.json`, "{}");
  write(root, "z-reader.ts");
  write(root, "z-agent.ts");
  const workspace = openWorkspace(root);
  for (const id of ["reader", "agent"])
    workspace.invoke("save_walkthrough", {
      id,
      title: id,
      steps: [{ id, title: id, source: { file: `z-${id}.ts`, symbol: "run" } }],
    });
  const before = workspace.invoke("project_overview", {
    walkthroughId: "reader",
  }).index.version;
  workspace.invoke("get_walkthrough", { id: "agent" });
  write(root, "z-unrelated.ts");
  workspace.invoke("inspect_source", { file: "z-unrelated.ts" });
  assert.equal(
    workspace.invoke("project_overview", { walkthroughId: "reader" }).index
      .version,
    before,
    "unrelated discovery and parsing must not reload the reader"
  );
  write(root, "z-reader.ts", "export function run() { return 9; }\n");
  assert.notEqual(
    workspace.invoke("project_overview", { walkthroughId: "reader" }).index
      .version,
    before
  );
  assert.equal(
    workspace.invoke("get_walkthrough", { id: "reader" }).steps[0].stale,
    true
  );
});

test("A file larger than the cache budget remains usable and is never falsely treated as a source change on reinspection", (t) => {
  const root = fixture(t);
  write(root, "flow.ts");
  const project = createSourceProject(root, { cacheBytes: 1 });
  const first = project.inspect("flow.ts"),
    before = project.snapshot().version;
  const second = project.inspect("flow.ts");
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, second);
  assert.equal(project.snapshot().version, before);
});

test("Native definition targets outside discovery are loaded directly without a project fallback scan", async (t) => {
  const root = fixture(t);
  write(root, "caller.ts", "export function caller() { return target(); }\n");
  for (let i = 0; i < 500; i++) write(root, `other/file-${i}.ts`);
  write(root, "z-target.ts", "export function target() { return 42; }\n");
  const service = await startProjectService(root, {
    assetsRoot: process.cwd(),
  });
  t.after(() => service.close());
  const walk = await service.call("save_walkthrough", {
    title: "Caller",
    steps: [
      {
        id: "caller",
        title: "Caller",
        source: { file: "caller.ts", symbol: "caller" },
      },
    ],
  });
  const calls = [];
  const client = {
    request: service.request,
    call(name, args) {
      calls.push([name, args]);
      return service.call(name, args);
    },
  };
  const result = await followReference(
    client,
    {
      walkthroughId: walk.id,
      stepId: "caller",
      fileHash: walk.steps[0].code.fileHash,
      line: 1,
      column: 34,
    },
    {
      findDefinitions: async () => ({
        locations: [{ file: "z-target.ts", startLine: 1, endLine: 1 }],
        external: false,
      }),
    }
  );
  assert.ok(result.stepId);
  assert.ok(
    calls
      .filter(([name]) => name === "resolve_reference")
      .every(([, args]) => args.identifyOnly)
  );
  assert.equal(
    (await service.call("get_walkthrough", { id: walk.id })).steps[1].source
      .file,
    "z-target.ts"
  );
});
