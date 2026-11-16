import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: [
    new URL("../ui/walkthrough-review-source.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const {
  walkthroughNotePosition: position,
  walkthroughStepInFile: inFile,
  walkthroughPurposePosition: purpose,
} = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const code = (fileHash = "old", text = "const amount = 1;") => ({
  file: "a.ts",
  fileHash,
  hash: fileHash + "-slice",
  startLine: 1,
  endLine: 1,
  excerpt: text,
  lines: [text],
});
const step = () => ({
  id: "original-card",
  source: { file: "a.ts", startLine: 1, endLine: 1 },
  snapshotHash: "old-slice",
  code: code(),
  stale: false,
});
const note = () => ({
  id: "original-note",
  body: "Keep actual author text",
  hash: "old-slice",
  attachments: [
    {
      file: "a.ts",
      fileHash: "old",
      startLine: 1,
      endLine: 1,
      startColumn: 6,
      endColumn: 12,
      text: "amount",
    },
  ],
});
const view = () => ({
  before: { code: code() },
  after: { code: code("new", "const amount = 2;") },
});
test("Original attachment selects exact BEFORE; live-working stale flag does not invalidate that historical byte version", () => {
  const n = Object.freeze({ ...note(), stale: true });
  assert.deepEqual(
    position({ ...step(), code: code("new"), stale: true }, n, view()),
    { side: "before", status: "current" }
  );
  assert.equal(n.id, "original-note");
  assert.equal(n.attachments[0].fileHash, "old");
});
test("Exact AFTER or identical sides show one copy of the same note", () => {
  const v = view();
  v.after.code = code();
  assert.deepEqual(position(step(), note(), v), {
    side: "after",
    status: "current",
  });
});
test("Path/group/rename placement alone cannot authorize annotations; whole-file hash, UTF16 text, every range and whole variable identifier must match", () => {
  const v = view();
  v.before.code = code("other");
  v.after.code = code("else");
  assert.ok(inFile(step(), { file: "renamed.ts", oldFile: "a.ts" }));
  assert.equal(position(step(), note(), v).status, "outdated");
  const bad = {
    ...note(),
    attachments: [{ ...note().attachments[0], text: "another" }],
  };
  assert.equal(position(step(), bad, view()).status, "outdated");
  assert.equal(
    position(
      step(),
      {
        ...note(),
        variableName: "am",
        attachments: [{ ...note().attachments[0], endColumn: 8, text: "am" }],
      },
      view()
    ).status,
    "outdated"
  );
  assert.equal(
    position(
      step(),
      {
        ...note(),
        attachments: [
          ...note().attachments,
          { ...note().attachments[0], fileHash: "foreign" },
        ],
      },
      view()
    ).status,
    "outdated"
  );
});
test("A manual review requirement is retained even for equal bytes", () => {
  assert.equal(
    position(step(), { ...note(), reviewRequired: true }, view()).status,
    "outdated"
  );
});
test("Plain notes require exact card hash and whole-file identity, not just same path/text", () => {
  const plain = { ...note(), attachments: [] };
  assert.deepEqual(position(step(), plain, view()), {
    side: "before",
    status: "current",
  });
  assert.equal(
    position({ ...step(), code: code("other") }, plain, view()).status,
    "outdated"
  );
});
test("Missing or unavailable Git sources do not suppress text or invent authority", () => {
  assert.deepEqual(position(step(), note(), null), {
    side: "after",
    status: "unverified",
  });
  const v = view();
  v.before.unavailable = "unknown";
  v.after.unavailable = "unknown";
  assert.equal(position(step(), note(), v).status, "unverified");
});
test("Purpose has independent exact-source/review status", () => {
  assert.deepEqual(purpose(step(), view()), {
    side: "before",
    status: "current",
  });
  assert.deepEqual(
    purpose({ ...step(), explanationReviewRequired: true }, view()),
    { side: "before", status: "outdated" }
  );
  assert.deepEqual(purpose(step(), null), {
    side: "after",
    status: "unverified",
  });
});
