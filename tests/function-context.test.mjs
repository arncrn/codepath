import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-function-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return { root, workspace: openWorkspace(root) };
}
function save(workspace, file, ranges) {
  return workspace.invoke("save_walkthrough", {
    title: "Not the function name",
    steps: ranges.map(([startLine, endLine = startLine], i) => ({
      id: "step-" + i,
      title: "Unrelated purpose",
      explanation: "Do not infer a function from this prose",
      source: { file, startLine, endLine },
    })),
  });
}

test("Current walkthrough identifies the innermost lexical function, not the card purpose or a same-name sibling", (t) => {
  const { workspace } = fixture(t, {
    "flow.ts":
      "function first() {\n  function same() {\n    return 1;\n  }\n}\nfunction second() {\n  function same() {\n    return 2;\n  }\n}\n",
  });
  const walk = save(workspace, "flow.ts", [[3], [8]]);
  const current = workspace.invoke("get_walkthrough", { id: walk.id });
  assert.deepEqual(
    current.steps.map((step) => step.code.functionContext),
    [
      {
        status: "function",
        name: "first › same",
        startLine: 2,
        startColumn: 2,
      },
      {
        status: "function",
        name: "second › same",
        startLine: 7,
        startColumn: 2,
      },
    ]
  );
});

test("A partial range spanning nested callbacks names its common lexical owner", (t) => {
  const { workspace, root } = fixture(t, {
    "flow.ts":
      "function outer() {\n  const before = 1;\n  items.map((item) => {\n    return item + before;\n  });\n  return before;\n}\n",
  });
  const walk = save(workspace, "flow.ts", [[2, 5], [4], [1, 7]]);
  const disk = path.join(root, ".codepaths/workspace.json");
  const saved = fs.readFileSync(disk, "utf8");
  const current = workspace.invoke("get_walkthrough", { id: walk.id });
  assert.deepEqual(current.steps[0].code.functionContext, {
    status: "function",
    name: "outer",
    startLine: 1,
    startColumn: 0,
  });
  assert.equal(current.steps[1].code.functionContext.name, "outer › anonymous");
  assert.equal(current.steps[2].code.functionContext.name, "outer");
  assert.equal(fs.readFileSync(disk, "utf8"), saved);
});

test("Same-name methods retain their lexical class owners", (t) => {
  const { workspace } = fixture(t, {
    "methods.ts":
      "class First {\n  run() {\n    return 1;\n  }\n}\nclass Second {\n  run() {\n    return 2;\n  }\n}\n",
  });
  const walk = save(workspace, "methods.ts", [[3], [8], [3, 8]]);
  const contexts = workspace
    .invoke("get_walkthrough", { id: walk.id })
    .steps.map((step) => step.code.functionContext);
  assert.deepEqual(contexts, [
    { status: "function", name: "First › run", startLine: 2, startColumn: 2 },
    { status: "function", name: "Second › run", startLine: 7, startColumn: 2 },
    { status: "multiple" },
  ]);
});

test("Callbacks, methods, assigned and anonymous functions use source scopes, while crossing scopes never selects an arbitrary function", (t) => {
  const { workspace } = fixture(t, {
    "view.tsx": [
      "class View {",
      "  render() {",
      "    items.map(function named(item) {",
      "      return <Box>{item}</Box>;",
      "    });",
      "    items.map((item) => {",
      "      return item;",
      "    });",
      "  }",
      "}",
      "const assigned = function local() {",
      "  return 3;",
      "};",
      "const arrow = () => 4;",
      "console.log(arrow);",
      "const one = () => 1, two = () => 2;",
    ].join("\n"),
  });
  const walk = save(workspace, "view.tsx", [
    [4],
    [7],
    [12],
    [14],
    [15],
    [4, 7],
    [1, 15],
    [16],
    [2, 9],
  ]);
  const contexts = workspace
    .invoke("get_walkthrough", { id: walk.id })
    .steps.map((step) => step.code.functionContext);
  assert.deepEqual(contexts, [
    {
      status: "function",
      name: "View › render › named",
      startLine: 3,
      startColumn: 14,
    },
    {
      status: "function",
      name: "View › render › anonymous",
      startLine: 6,
      startColumn: 14,
    },
    {
      status: "function",
      name: "assigned (local)",
      startLine: 11,
      startColumn: 17,
    },
    { status: "function", name: "arrow", startLine: 14, startColumn: 14 },
    { status: "no-function" },
    { status: "function", name: "View › render", startLine: 2, startColumn: 2 },
    { status: "multiple" },
    { status: "multiple" },
    { status: "function", name: "View › render", startLine: 2, startColumn: 2 },
  ]);
});

test("Go context distinguishes receiver methods, callbacks and complex signatures while masking false functions", (t) => {
  const { workspace } = fixture(t, {
    "main.go":
      'package main\n// func fake() {}\nfunc same() {\n  println("func fake() {}")\n}\ntype Reader struct {}\nfunc (r *Reader) same() {\n  println(r)\n}\nvar top = 1\n',
    "callback.go":
      "package main\nfunc run() {\n  callback := func() {\n    println(1)\n  }\n  callback()\n}\n",
    "generic.go": "package main\nfunc run[T any](v T) T {\n  return v\n}\n",
    "interface.go": "package main\nfunc run() interface{} {\n  return nil\n}\n",
  });
  const walk = save(workspace, "main.go", [[4], [8], [10], [4, 8]]);
  assert.deepEqual(
    workspace
      .invoke("get_walkthrough", { id: walk.id })
      .steps.map((step) => step.code.functionContext),
    [
      { status: "function", name: "same", startLine: 3, startColumn: 0 },
      { status: "function", name: "Reader.same", startLine: 7, startColumn: 0 },
      { status: "no-function" },
      { status: "multiple" },
    ]
  );
  for (const file of ["callback.go", "generic.go", "interface.go"]) {
    const current = save(workspace, file, [[3]]);
    assert.equal(current.steps[0].code.functionContext.name, "run");
  }
  const callback = save(workspace, "callback.go", [[4]]);
  assert.equal(callback.steps[0].code.functionContext.name, "run › anonymous");
});

for (const { title, source, expected } of [
  {
    title:
      "exported/unexported functions and pointer/value struct methods coexist with function types",
    source: `package main
type Server struct{}
type Store[T any] struct{}
type Hook func() error
var hook func()
var store Store[int]
func Public() {
  println(1) // card
}
func private() {
  println(2) // card
}
func (s *Server) Public(hook func(int) error) {
  println(3) // card
}
func (s Server) private() {
  println(4) // card
}
func constructor() {
  println(5) // card
}
`,
    expected: [
      "Public",
      "private",
      "Server.Public",
      "Server.private",
      "constructor",
    ],
  },
  {
    title:
      "generic constraints and generic/unnamed receivers keep their struct owners",
    source: `package main
type Store[T any] struct { Value T }
func Identity[T interface { ~int | ~string }](value T) T {
  return value // card
}
func (s *Store[T]) Load() T {
  return s.Value // card
}
func (Store[T]) hidden() {
  println(1) // card
}
func (*Store[T]) Unnamed() {
  println(2) // card
}
`,
    expected: ["Identity", "Store.Load", "Store.hidden", "Store.Unnamed"],
  },
  {
    title:
      "signature braces and function result types never become function bodies",
    source: `package main
func Shape() struct { X int; Hook func() } {
  return struct { X int; Hook func() }{} // card
}
func Contract() interface { Run(func() error) } {
  return nil // card
}
func Factory() func() error {
  println(1) // card
  return func() error {
    return nil // card
  }
}
func Nested() func() func() {
  println(2) // card
  return nil
}
func Collections() map[string][]chan<- func() error {
  return nil // card
}
func Channels() <-chan struct { X int } {
  return nil // card
}
func Results() (value map[string]func(), err error) {
  return nil, nil // card
}
func Builder() {
  maker := func() func() {
    return func() {
      println(3) // card
    }
  }
  _ = maker
}
`,
    expected: [
      "Shape",
      "Contract",
      "Factory",
      "Factory › anonymous",
      "Nested",
      "Collections",
      "Channels",
      "Results",
      "Builder › anonymous › anonymous",
    ],
  },
  {
    title:
      "nested literals, goroutines and deferred callbacks retain the lexical outer function",
    source: `package main
func Run() {
  callback := func() {
    func() {
      println(1) // card
    }()
  }
  go func() {
    println(2) // card
  }()
  defer func() {
    println(3) // card
  }()
  callback() // card
}
`,
    expected: [
      "Run › anonymous › anonymous",
      "Run › anonymous",
      "Run › anonymous",
      "Run",
    ],
  },
  {
    title:
      "function types and bodyless declarations do not consume the following function",
    source: `package main
type Hook func() // card
var hook func() error // card
func External()
type Bare func()
func (Bare) Call() {
  println(0) // card
}
func Actual() {
  println(1) // card
}
var callbacks = []func(){ // card
  func() {
    println(2) // card
  },
}
`,
    expected: [
      "no-function",
      "no-function",
      "Bare.Call",
      "Actual",
      "no-function",
      "anonymous",
    ],
  },
  {
    title:
      "collection function types are not callbacks, while sends and arithmetic can contain literals",
    source: `package main
var pointers = []*func(){nil} // card
var nested = [1][2]*func(){{nil, nil}} // card
var channels = map[string]<-chan func(){"one": nil} // card
func Send(ch chan func(), values []int) {
  ch <- func() {
    println(1) // card
  }
  number := values[0] * func() int {
    return 2 // card
  }()
  _ = number
}
`,
    expected: [
      "no-function",
      "no-function",
      "no-function",
      "Send › anonymous",
      "Send › anonymous",
    ],
  },
  {
    title:
      "function types in switches and union constraints do not poison unrelated scopes",
    source: `package main
type Callbacks interface { ~func() | ~func() error }
func Run(value any) {
  var callback func()
  println(1) // card
  switch value.(type) {
  case func():
    println(2) // card
  case func() error:
    println(3) // card
  }
  _ = callback
}
`,
    expected: ["Run", "Run", "Run"],
  },
  {
    title:
      "Unicode identifiers, multiline signatures, comments and raw strings preserve source positions",
    source:
      "package main\ntype 服务 struct{}\n// func fake() {}\nfunc (s *服务) 处理(\n  callback func(),\n) (result struct { X int }) {\n  println(`func fake() {}`) // card\n}\n",
    expected: ["服务.处理"],
  },
]) {
  test("Go " + title, (t) => {
    const { workspace } = fixture(t, { "main.go": source });
    const ranges = source
      .split("\n")
      .flatMap((line, i) => (line.includes("// card") ? [[i + 1]] : []));
    const walk = save(workspace, "main.go", ranges);
    assert.deepEqual(
      walk.steps.map((step) => {
        const context = step.code.functionContext;
        return context.status === "function" ? context.name : context.status;
      }),
      expected
    );
  });
}

test("Malformed Go scopes stay unknown rather than assigning an arbitrary enclosing name", (t) => {
  const { workspace } = fixture(t, {
    "broken.go":
      "package main\nfunc Run() {\n  callback := func() {\n    println(1)\n",
  });
  assert.equal(
    save(workspace, "broken.go", [[4]]).steps[0].code.functionContext.status,
    "unknown"
  );
});

test("Go renames refresh context without reviewing explanations or writing reader state", (t) => {
  const source =
    "package main\nfunc (s *Server) Before(callback func()) {\n  println(1)\n}\n";
  const { workspace, root } = fixture(t, { "main.go": source });
  const walk = save(workspace, "main.go", [[3]]);
  const disk = path.join(root, ".codepaths/workspace.json");
  const saved = fs.readFileSync(disk, "utf8");
  const mtime = fs.statSync(disk).mtimeMs;
  fs.writeFileSync(
    path.join(root, "main.go"),
    source.replace("Before", "After")
  );
  const current = workspace.invoke("get_walkthrough", { id: walk.id });
  assert.equal(current.steps[0].code.functionContext.name, "Server.After");
  assert.equal(current.steps[0].snapshotHash, walk.steps[0].snapshotHash);
  assert.equal(current.steps[0].stale, false);
  assert.equal(fs.readFileSync(disk, "utf8"), saved);
  assert.equal(fs.statSync(disk).mtimeMs, mtime);
});

test("A callback elsewhere in a Go file does not hide an ordinary function's name", (t) => {
  const { workspace } = fixture(t, {
    "main.go":
      "package main\nfunc Public() {\n  println(1)\n}\nfunc private() {\n  call(func() {})\n}\n",
  });
  const walk = save(workspace, "main.go", [[3]]);
  assert.equal(walk.steps[0].code.functionContext.status, "function");
  assert.equal(walk.steps[0].code.functionContext.name, "Public");
});

test("Late source, eviction and file edits refresh context without reader writes, note loss or automatic review", (t) => {
  const { root, workspace } = fixture(t, {
    "z-late/flow.js": "export function before() {\n  return 1;\n}\n",
    "broken.ts": "function broken( {\n  return 1;\n",
    ...Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `a-unrelated-${i}.ts`,
        "export const n = () => 0;\n",
      ])
    ),
  });
  const walk = save(workspace, "z-late/flow.js", [[2]]);
  const note = workspace.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: "step-0",
    body: "Keep my plain note",
    author: "Reader",
  });
  const disk = path.join(root, ".codepaths/workspace.json");
  const before = fs.readFileSync(disk, "utf8"),
    stat = fs.statSync(disk);
  // Force eviction through the same public source-inspection interface used by
  // the picker, without changing discovery eligibility or walkthrough contents.
  for (let i = 0; i < 140; i++) {
    workspace.invoke("inspect_source", { file: `a-unrelated-${i}.ts` });
  }
  assert.equal(
    workspace.invoke("get_walkthrough", { id: walk.id }).steps[0].code
      .functionContext.name,
    "before"
  );
  fs.writeFileSync(
    path.join(root, "z-late/flow.js"),
    "export function after() {\n  return 1;\n}\n"
  );
  const renamed = workspace.invoke("get_walkthrough", { id: walk.id });
  assert.equal(renamed.steps[0].code.functionContext.name, "after");
  assert.equal(
    renamed.steps[0].stale,
    false,
    "unchanged selected code is still current; outer source identity is freshly parsed"
  );
  fs.writeFileSync(
    path.join(root, "z-late/flow.js"),
    "export function after() {\n  return 9;\n}\n"
  );
  const changed = workspace.invoke("get_walkthrough", { id: walk.id });
  assert.equal(changed.steps[0].code.functionContext.name, "after");
  assert.equal(changed.steps[0].snapshotHash, walk.steps[0].snapshotHash);
  assert.deepEqual(changed.steps[0].source, walk.steps[0].source);
  assert.equal(changed.steps[0].explanation, walk.steps[0].explanation);
  assert.equal(changed.steps[0].stale, true);
  assert.equal(changed.steps[0].notes[0].id, note.id);
  assert.equal(changed.steps[0].notes[0].body, note.body);
  assert.equal(changed.steps[0].notes[0].stale, true);
  fs.unlinkSync(path.join(root, "z-late/flow.js"));
  const unavailable = workspace.invoke("get_walkthrough", { id: walk.id });
  assert.ok(unavailable.steps[0].error);
  assert.equal(unavailable.steps[0].code, undefined);
  assert.equal(unavailable.steps[0].notes[0].id, note.id);
  assert.equal(unavailable.revision, renamed.revision);
  assert.equal(fs.readFileSync(disk, "utf8"), before);
  assert.equal(fs.statSync(disk).mtimeMs, stat.mtimeMs);
  const broken = save(workspace, "broken.ts", [[2]]);
  assert.equal(broken.steps[0].code.functionContext.status, "unknown");
});

test("Non-function class initialization is not mislabeled as a method or top-level declaration", (t) => {
  const { workspace } = fixture(t, {
    "static.ts":
      "class View {\n  static {\n    console.log(1);\n  }\n  value = 2;\n}\n",
  });
  const walk = save(workspace, "static.ts", [[3], [5]]);
  assert.deepEqual(
    walk.steps.map((step) => step.code.functionContext),
    [{ status: "no-function" }, { status: "no-function" }]
  );
});

for (const extension of ["js", "jsx", "ts", "tsx"]) {
  test(`${extension} current source recognizes anonymous and arrow scopes without a prose classification`, (t) => {
    const file = `view.${extension}`;
    const { workspace } = fixture(t, {
      [file]:
        "export default function () {\n  const arrow = () => {\n    return 1;\n  };\n  return arrow();\n}\n",
    });
    const walk = save(workspace, file, [[3], [5]]);
    assert.deepEqual(
      walk.steps.map((step) => step.code.functionContext.name),
      ["anonymous › arrow", "anonymous"]
    );
  });
}
