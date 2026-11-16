import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: [
    new URL("../ui/review-explanation-homes.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { explanationHomes } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const file = (id, group = "compare", name = "a.ts", oldFile) => ({
  id,
  group,
  file: name,
  ...(oldFile ? { oldFile } : {}),
});
const step = (id, source) => ({
  id,
  fileId: source.id,
  file: source,
  binding: "immutable-original",
  annotations: { notes: [] },
});
test("Display grouping uses exact file identity or one unambiguous path/group, without modifying source identity", () => {
  const original = step("s", file("saved")),
    current = file("current", "unstaged");
  const result = explanationHomes([original], [current]);
  assert.deepEqual(result.byFile.get("current"), [original]);
  assert.equal(original.binding, "immutable-original");
  assert.equal(original.fileId, "saved");
  assert.deepEqual(result.unmatched, []);
});
test("A partially staged path never invents a preferred source pair; ambiguous explanations remain visible separately", () => {
  const s = step("s", file("saved"));
  const result = explanationHomes(
    [s],
    [file("staged", "staged"), file("unstaged", "unstaged")]
  );
  assert.equal(result.byFile.size, 0);
  assert.deepEqual(result.unmatched, [s]);
  const exact = step("e", file("unstaged", "unstaged"));
  assert.deepEqual(
    explanationHomes(
      [exact],
      [file("staged", "staged"), file("unstaged", "unstaged")]
    ).byFile.get("unstaged"),
    [exact]
  );
});
test("Renames and missing inventory do not silently relocate original explanations", () => {
  const s = step("s", file("saved", "compare", "new.ts", "old.ts"));
  assert.deepEqual(
    explanationHomes([s], [file("different", "unstaged", "new.ts")]).unmatched,
    [s]
  );
  assert.deepEqual(explanationHomes([s], []).unmatched, [s]);
});
