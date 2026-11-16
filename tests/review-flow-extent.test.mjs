import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: [new URL("../ui/git-diff-rows.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { focusedRows } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
test("Focused Flow reveal adds a real aligned unchanged window without dropping any hunk or inventing a diff", () => {
  const nums = Array.from({ length: 100 }, (_, i) => i + 1),
    rows = {
      before: nums,
      after: nums,
      removed: new Set([10, 45]),
      added: new Set([10, 45]),
    },
    ordinary = focusedRows(rows),
    revealed = focusedRows(rows, { side: "after", startLine: 80, endLine: 82 }),
    real = (r) => r.filter((n) => typeof n === "number");
  assert.ok(!real(ordinary.after).includes(80));
  assert.ok(
    real(revealed.after).includes(80) && real(revealed.after).includes(82)
  );
  assert.ok(
    real(ordinary.after).every((n) => real(revealed.after).includes(n))
  );
  assert.deepEqual(real(revealed.before), real(revealed.after));
  assert.deepEqual([...revealed.added], [10, 45]);
  assert.ok(revealed.after.includes("omitted"));
});
