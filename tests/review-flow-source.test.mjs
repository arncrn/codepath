import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: [
    new URL("../ui/review-flow-source.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { reviewFlowSides } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
const code = (fileHash = "whole-current", file = "a.ts") => ({
  file,
  fileHash,
  hash: "card-current",
  startLine: 1,
  endLine: 2,
  lines: ["const value = 1;", "😀value"],
  excerpt: "const value = 1;\n😀value",
});
const a = {
  file: "a.ts",
  fileHash: "whole-current",
  startLine: 2,
  endLine: 2,
  startColumn: 2,
  endColumn: 7,
  text: "value",
};
const node = {
    id: "s0",
    stepId: "step",
    label: "Use the value",
    sourceHash: "card-current",
    attachment: a,
  },
  focus = { walkthroughId: "original", node };
const walk = () => ({
  id: "original",
  flowState: { status: "current", definition: "flowchart TD", nodes: [node] },
  steps: [{ id: "step", code: code() }],
});
const view = () => ({
  before: { code: code("different-whole-file") },
  after: { code: code() },
});
test("Flow admits exact AFTER independently of annotation query but rejects identical snippet in another whole-file version", () =>
  assert.deepEqual(reviewFlowSides(walk(), focus, view()), ["after"]));
test("When both raw sides are the same exact version both are honestly admitted", () => {
  const v = view();
  v.before.code = code();
  assert.deepEqual(reviewFlowSides(walk(), focus, v), ["before", "after"]);
});
test("A graph/node/card hash mismatch, stale graph or changed full file never authorizes marks", () => {
  for (const w of [
    { ...walk(), flowState: { ...walk().flowState, status: "stale" } },
    { ...walk(), steps: [] },
    {
      ...walk(),
      steps: [{ id: "step", code: { ...code(), hash: "changed" } }],
    },
    { ...walk(), steps: [{ id: "step", code: code("changed") }] },
  ])
    assert.deepEqual(reviewFlowSides(w, focus, view()), []);
  assert.deepEqual(
    reviewFlowSides(
      walk(),
      { ...focus, node: { ...node, sourceHash: "forged" } },
      view()
    ),
    []
  );
});
test("UTF16 range/text proof is exact; wrong coordinates and same-path text do not attach", () => {
  const bad = { ...node, attachment: { ...a, startColumn: 1 } };
  assert.deepEqual(
    reviewFlowSides(
      { ...walk(), flowState: { ...walk().flowState, nodes: [bad] } },
      { ...focus, node: bad },
      view()
    ),
    []
  );
});
test("Renames do not move bindings: only matching literal side path can be admitted", () => {
  const v = view();
  v.before.code = code();
  v.after.code = code("whole-current", "renamed.ts");
  assert.deepEqual(reviewFlowSides(walk(), focus, v), ["before"]);
});
test("Unavailable or absent source remains unavailable even with a matching metadata hash", () => {
  const v = view();
  v.after.unavailable = "Not admitted";
  assert.deepEqual(reviewFlowSides(walk(), focus, v), []);
  assert.deepEqual(reviewFlowSides(null, focus, view()), []);
});
