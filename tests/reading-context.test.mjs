import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  dispatchReadingContext,
  dispatchWebviewRequest,
} from "../dist/vscode/bridge.mjs";
const compiled = await build({
  entryPoints: ["ui/reading-context.ts"],
  bundle: true,
  write: false,
  format: "esm",
});
const { parseReadingContext, readingContextKey } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const position = {
  version: 1,
  walkthroughId: "walk",
  stepId: "step",
  tab: "notes",
  focusNonce: "seen",
};
test("Reading context accepts only bounded position fields and survives absent/malformed input", () => {
  for (const value of [
    null,
    [],
    {},
    { ...position, version: 2 },
    { ...position, tab: "source" },
    { ...position, stepId: 5 },
    { ...position, focusNonce: "x".repeat(201) },
  ])
    assert.equal(parseReadingContext(value), null);
  assert.deepEqual(parseReadingContext(position), position);
  assert.deepEqual(parseReadingContext({ ...position, tab: "flow" }), {
    ...position,
    tab: "flow",
  });
  assert.deepEqual(
    parseReadingContext({ ...position, draft: "must not persist" }),
    position
  );
  assert.notEqual(readingContextKey("/a"), readingContextKey("/b"));
});
test("Legacy Data reading positions restore Notes while retaining the exact walkthrough/step/focus", () => {
  const legacy = { ...position, tab: "data" };
  assert.deepEqual(parseReadingContext(legacy), position);
  assert.equal(
    legacy.tab,
    "data",
    "Reading an old preference does not mutate the stored input"
  );
});
test("Native legacy Data preference normalizes to Notes without rewriting stored workspaceState on read", async () => {
  const legacy = { ...position, tab: "data" };
  const state = {
    get: () => legacy,
    update: async () => {
      throw Error("Read must not write");
    },
  };
  assert.deepEqual(
    await dispatchReadingContext(state, "/a", "reading-context/get"),
    position
  );
  assert.equal(legacy.tab, "data");
});
test("Host workspaceState bridge binds keys to session roots and rejects arbitrary payloads/routes", async () => {
  const values = new Map();
  const state = {
    get: (key) => values.get(key),
    update: async (key, value) => {
      values.set(key, value);
    },
  };
  assert.equal(
    await dispatchReadingContext(state, "/a", "reading-context/get"),
    null
  );
  await dispatchReadingContext(state, "/a", "reading-context/set", position);
  assert.deepEqual(
    await dispatchReadingContext(state, "/a", "reading-context/get"),
    position
  );
  const flow = { ...position, tab: "flow" };
  await dispatchReadingContext(state, "/a", "reading-context/set", flow);
  assert.deepEqual(
    await dispatchReadingContext(state, "/a", "reading-context/get"),
    flow
  );
  assert.equal(
    await dispatchReadingContext(state, "/b", "reading-context/get"),
    null
  );
  for (const body of [
    { ...position, root: "/b" },
    { ...position, token: "secret" },
    {},
    null,
  ])
    await assert.rejects(
      dispatchReadingContext(state, "/a", "reading-context/set", body),
      /Invalid/
    );
  await assert.rejects(
    dispatchReadingContext(state, "/a", "reading-context/get", { root: "/b" }),
    /Unsupported/
  );
  await assert.rejects(
    dispatchReadingContext(state, "/a", "/api/state"),
    /Unsupported/
  );
  await assert.rejects(
    dispatchWebviewRequest({}, "reading-context/set", position),
    /Unsupported/
  );
  values.set(readingContextKey("/a"), { ...position, tab: "bad" });
  assert.equal(
    await dispatchReadingContext(state, "/a", "reading-context/get"),
    null
  );
});
