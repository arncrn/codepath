import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = await fs.mkdtemp(path.join(os.tmpdir(), "codepath-syntax-"));
let tokenizeSource;
try {
  await build({
    entryPoints: ["ui/source-syntax.ts"],
    outfile: path.join(output, "syntax.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  ({ tokenizeSource } = await import(
    pathToFileURL(path.join(output, "syntax.mjs"))
  ));
} finally {
  await fs.rm(output, { recursive: true, force: true });
}

function checkedRuns(file, text) {
  const lines = text.split("\n");
  const result = tokenizeSource(file, lines);
  assert.equal(result.length, lines.length);
  for (const [index, runs] of result.entries()) {
    let column = 0;
    for (const run of runs) {
      assert.equal(run.line, index + 1);
      assert.equal(run.startColumn, column);
      assert.ok(run.endColumn > column);
      assert.ok(run.endColumn <= lines[index].length);
      column = run.endColumn;
    }
    assert.equal(column, lines[index].length);
  }
  assert.equal(
    result
      .map((runs, index) =>
        runs
          .map((run) => lines[index].slice(run.startColumn, run.endColumn))
          .join("")
      )
      .join("\n"),
    text
  );
  return result.flat().map((run) => ({
    ...run,
    text: lines[run.line - 1].slice(run.startColumn, run.endColumn),
  }));
}

test("browser bundle includes only required grammars and no TypeScript compiler", async () => {
  const bundle = await build({
    entryPoints: ["ui/source-syntax.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    metafile: true,
    minify: true,
  });
  const inputs = Object.keys(bundle.metafile.inputs).map((file) =>
    file.replaceAll("\\", "/")
  );
  assert.deepEqual(
    inputs
      .filter((file) => /(?:^|\/)node_modules\/refractor\/lang\//.test(file))
      .map((file) => path.basename(file))
      .sort(),
    [
      "clike.js",
      "go.js",
      "javascript.js",
      "jsx.js",
      "markup.js",
      "tsx.js",
      "typescript.js",
    ]
  );
  assert.ok(
    !inputs.some((file) => /(?:^|\/)node_modules\/typescript\//.test(file))
  );
  assert.ok(
    Object.values(bundle.metafile.outputs).every(
      (output) => output.imports.length === 0
    )
  );
  assert.match(bundle.outputFiles[0].text, /Copyright \(c\) Lea Verou/);
  assert.match(bundle.outputFiles[0].text, /Permission is hereby granted/);
});

for (const extension of ["js", "mjs", "cjs", "ts", "mts", "cts"]) {
  test(`${extension} grammar distinguishes comments, strings and keywords`, () => {
    const runs = checkedRuns(
      `flow.${extension}`,
      '/* const fake = 1;\n continued */\nexport const value = "return"; // let\n'
    );
    assert.ok(runs.some((run) => run.line === 2 && run.kind === "comment"));
    assert.ok(
      runs.some((run) => run.text === "const" && run.kind === "keyword")
    );
    assert.ok(
      runs.some((run) => run.text === '"return"' && run.kind === "string")
    );
    assert.ok(!runs.some((run) => run.line < 3 && run.kind === "keyword"));
  });
}

for (const extension of ["jsx", "tsx"]) {
  test(`${extension} grammar handles tags, attributes, entities and embedded expressions`, () => {
    const typed = extension === "tsx" ? ": string" : "";
    const runs = checkedRuns(
      `view.${extension}`,
      `const label${typed} = "hi";\nconst view = <Box title="&amp;">literal return {label + 2}</Box>;`
    );
    assert.ok(runs.some((run) => run.text === "Box" && run.kind === "type"));
    assert.ok(
      runs.some((run) => run.text === "title" && run.kind === "attribute")
    );
    assert.ok(runs.some((run) => run.text === "&amp;"));
    assert.ok(
      !runs.some(
        (run) => run.text.includes("literal return") && run.kind === "keyword"
      )
    );
    assert.ok(runs.some((run) => run.text === "2" && run.kind === "number"));
    if (typed)
      assert.ok(
        runs.some((run) => run.text === "string" && run.kind === "type")
      );
  });
}

test("Go grammar handles raw multiline strings, comments and declarations", () => {
  const runs = checkedRuns(
    "main.go",
    "package main\n/* func fake() {}\n still comment */\nfunc main() {\n\tvalue := `raw\nfunc <img>&amp;`\n\tprintln(value, 42)\n}\n"
  );
  assert.ok(
    runs.some((run) => run.text === "package" && run.kind === "keyword")
  );
  assert.ok(
    runs.some(
      (run) => run.text === "func" && run.kind === "keyword" && run.line === 4
    )
  );
  assert.ok(runs.some((run) => run.line === 6 && run.kind === "string"));
  assert.ok(runs.some((run) => run.text === "42" && run.kind === "number"));
});

test("text and UTF-16 coordinates survive hostile text, CRLF, tabs, blank lines and incomplete code", () => {
  for (const text of [
    'const emoji = "😀";\tcall(emoji);\r\n\r\n',
    'const x = "</code><img src=x onerror=alert(1)>&amp;";\n',
    '<Box title="&lt;">&amp;{value}</Box>',
    "const unfinished = `hello\n${call(",
    "",
    "\n\n",
  ])
    checkedRuns("view.tsx", text);
  const runs = checkedRuns("flow.ts", 'const emoji = "😀"; call(emoji)');
  assert.equal(runs.find((run) => run.text === "call").startColumn, 20);
});

test("unsupported files stay plain and calls are deterministic without mutating source", () => {
  const lines = Object.freeze(["<img>&amp; const x = 1", ""]);
  const first = tokenizeSource("notes.txt", lines);
  assert.deepEqual(first, [
    [{ line: 1, startColumn: 0, endColumn: lines[0].length, kind: "plain" }],
    [],
  ]);
  assert.deepEqual(tokenizeSource("notes.txt", lines), first);
});
