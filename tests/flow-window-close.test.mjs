import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: [new URL("../vscode/flow-window.mts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "owned-vscode-boundary",
      setup(b) {
        b.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export const commands={getCommands:async()=>[]};export const ViewColumn={Beside:2};export const window={createWebviewPanel:(...args)=>globalThis.flowCloseFixture.create(...args)};`,
          loader: "js",
        }));
      },
    },
  ],
});
const { createFlowWindow } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
function fixture() {
  const messages = [],
    panels = [];
  globalThis.flowCloseFixture = {
    create() {
      let disposed = false;
      const callbacks = [];
      const panel = {
        webview: {
          postMessage: async () => true,
          onDidReceiveMessage(fn) {
            panel.receive = fn;
          },
        },
        onDidDispose(fn) {
          callbacks.push(fn);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const fn of callbacks) fn();
        },
        reveal() {},
      };
      panels.push(panel);
      return panel;
    },
  };
  const reader = {
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        postMessage: async (message) => {
          messages.push(message);
          return true;
        },
      },
    },
    flow = createFlowWindow(() => "<p>Owned Flow</p>", []);
  return { flow, reader, messages, panels };
}
test("Native child Close window retires and notifies the reader exactly once, before any next publish", async () => {
  const f = fixture(),
    open = await f.flow.open(f.reader),
    panel = f.panels[0];
  await panel.receive({
    type: "codepath.request",
    id: "ready",
    route: "flow/ready",
    body: { view: "child-a" },
  });
  await panel.receive({
    type: "codepath.request",
    id: "close",
    route: "flow/close",
    body: { view: "child-a" },
  });
  assert.deepEqual(
    f.messages.filter((m) => m.type === "codepath.flow.closed"),
    [{ type: "codepath.flow.closed", session: open.session }]
  );
  panel.dispose();
  assert.equal(
    f.messages.filter((m) => m.type === "codepath.flow.closed").length,
    1
  );
});
test("Lease close and ordinary native disposal notify once; stale close cannot retire a new equal-reader connection", async () => {
  const f = fixture(),
    old = await f.flow.open(f.reader);
  await f.flow.close(f.reader, { session: old.session, lease: old.lease });
  assert.equal(
    f.messages.filter((m) => m.type === "codepath.flow.closed").length,
    1
  );
  const fresh = await f.flow.open(f.reader);
  assert.notEqual(fresh.session, old.session);
  await f.flow.close(f.reader, { session: old.session, lease: old.lease });
  assert.equal(
    f.messages.filter((m) => m.type === "codepath.flow.closed").length,
    1
  );
  f.panels[1].dispose();
  assert.equal(
    f.messages.filter((m) => m.type === "codepath.flow.closed").length,
    2
  );
});
