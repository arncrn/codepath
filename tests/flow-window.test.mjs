import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
let serial = 0;
async function load(file, plugins = []) {
  const b = await build({
    entryPoints: [new URL(file, import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins,
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(b.outputFiles[0].text).toString("base64") +
      "#" +
      ++serial
  );
}
const { flowSelection, flowState } = await load("../ui/flow-window-wire.ts");
function state(viewer = "view-A", epoch = "epoch-A") {
  return {
    type: "codepath.flow.state",
    root: "/root-A",
    session: "physical-window-A",
    viewer,
    epoch,
    walkthrough: {
      id: "walk",
      title: "Guide",
      steps: [],
      flowState: {
        status: "current",
        nodes: [{ id: "s0", stepId: "card", sourceHash: "current" }],
      },
    },
  };
}
const select = (s) => ({
  type: "codepath.flow.select",
  root: s.root,
  session: s.session,
  viewer: s.viewer,
  epoch: s.epoch,
  nodeId: "s0",
});
test("Detached selections resolve only current parent nodes; root/session/view/source lifetime mismatches never navigate", () => {
  const s = state(),
    m = select(s);
  assert.equal(flowState(s), true);
  assert.equal(flowSelection(m, s).node, s.walkthrough.flowState.nodes[0]);
  for (const key of ["root", "session", "viewer", "epoch", "nodeId"])
    assert.equal(flowSelection({ ...m, [key]: "foreign" }, s), null);
  for (const value of [null, [], {}, "bad", { ...m, nodeId: 3 }])
    assert.equal(flowSelection(value, s), null);
  assert.equal(
    flowSelection(m, state("new-document-same-window")),
    null,
    "Recreated popup rejects old callbacks even if guide/source bytes equal"
  );
  assert.equal(
    flowSelection(m, state("view-A", "new-epoch-same-guide")),
    null,
    "Leaving and restoring guide does not revive old selection"
  );
  assert.equal(flowSelection(m, { ...s, walkthrough: null }), null);
});
test("After display metadata is bounded and cannot supply a selection side or source authority", () => {
  const s = {
    ...state(),
    source: {
      side: "after",
      label: "After · HEAD",
      message: "Checking After Flow",
    },
  };
  assert.equal(flowState(s), true);
  for (const source of [
    null,
    [],
    { side: "before", label: "Before" },
    { side: "after", label: 3 },
    { side: "after", label: "x".repeat(1001) },
    { side: "after", label: "After", message: 3 },
    { side: "after", label: "After", message: "x".repeat(2001) },
  ])
    assert.equal(flowState({ ...s, source }), false);
  assert.equal(
    flowSelection(
      {
        ...select(s),
        side: "before",
        attachment: { file: "foreign" },
        tool: "save_note",
      },
      s
    ).node,
    s.walkthrough.flowState.nodes[0]
  );
});
test("Detached change metadata covers only current generated node IDs with bounded known statuses", () => {
  const s = {
    ...state(),
    source: { side: "after", label: "After", changes: { s0: "changed" } },
  };
  assert.equal(flowState(s), true);
  for (const changes of [
    {},
    { s1: "changed" },
    { s0: "changed", s1: "unknown" },
    { s0: "behavior-changed" },
    {
      s0: {
        toString() {
          return "changed";
        },
      },
    },
    [],
    null,
  ])
    assert.equal(flowState({ ...s, source: { ...s.source, changes } }), false);
  assert.equal(flowState({ ...s, walkthrough: null }), false);
  assert.equal(
    flowState({ ...s, source: { ...s.source, changes: { s0: "unchanged" } } }),
    true
  );
  assert.equal(
    flowState({ ...s, source: { ...s.source, changes: { s0: "unknown" } } }),
    true
  );
  assert.equal(
    flowSelection(
      { ...select(s), changes: { s0: "unchanged" }, side: "before" },
      s
    ).node,
    s.walkthrough.flowState.nodes[0]
  );
});
function fakeHost() {
  const groups = [{ viewColumn: 1, tabs: [] }],
    panels = [],
    executed = [];
  class Panel {
    constructor(type, column) {
      this.type = type;
      this.viewColumn = column;
      this.disposed = false;
      this.receivers = [];
      this.disposals = [];
      this.sent = [];
      this.group = groups.find((g) => g.viewColumn === column);
      this.group?.tabs.push(this);
      this.webview = {
        postMessage: async (m) => {
          this.sent.push(m);
          return !this.disposed;
        },
        onDidReceiveMessage: (fn) => {
          this.receivers.push(fn);
          return { dispose() {} };
        },
        html: "",
      };
    }
    onDidDispose(fn) {
      this.disposals.push(fn);
      return {
        dispose: () => {
          this.disposals = this.disposals.filter((f) => f !== fn);
        },
      };
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (this.group)
        this.group.tabs = this.group.tabs.filter((p) => p !== this);
      for (const fn of this.disposals) fn();
    }
    reveal() {}
    async message(route, body) {
      for (const fn of this.receivers)
        await fn({ type: "codepath.request", id: "request", route, body });
    }
  }
  const api = {
    window: {
      tabGroups: {
        get all() {
          return groups;
        },
        close: async (g) => {
          const i = groups.indexOf(g);
          if (i >= 0) groups.splice(i, 1);
        },
      },
      createWebviewPanel: (type, title, column) => {
        const p = new Panel(type, column);
        p.title = title;
        panels.push(p);
        return p;
      },
    },
    commands: {
      getCommands: async () => ["workbench.action.newEmptyEditorWindow"],
      executeCommand: async (name) => {
        executed.push(name);
        groups.push({ viewColumn: 2, tabs: [] });
      },
    },
    ViewColumn: { Beside: 2 },
  };
  return { api, panels, executed, reader: new Panel("reader", 1) };
}
async function adapter(host) {
  globalThis.flowTestHost = host.api;
  return load("../vscode/flow-window.mts", [
    {
      name: "fake-sdk",
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "sdk",
        }));
        build.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({
          contents:
            "export const window=globalThis.flowTestHost.window; export const commands=globalThis.flowTestHost.commands; export const ViewColumn=globalThis.flowTestHost.ViewColumn;",
          loader: "js",
        }));
      },
    },
  ]);
}
test("Native Flow uses own new empty group, rejects writable routes and stale view/close leases", async () => {
  const host = fakeHost(),
    { createFlowWindow } = await adapter(host),
    controller = createFlowWindow(() => "<html/>", []),
    first = await controller.open(host.reader),
    popup = host.panels[0];
  assert.equal(popup.viewColumn, 2);
  assert.equal(host.reader.viewColumn, 1);
  assert.deepEqual(host.executed, ["workbench.action.newEmptyEditorWindow"]);
  await popup.message("flow/ready", { view: "view-A" });
  assert.equal(host.reader.sent.at(-1).type, "codepath.flow.ready");
  const s = {
    ...state(),
    session: first.session,
    source: { side: "after", label: "After · HEAD" },
  };
  await controller.publish(host.reader, s);
  await popup.message("/api/call", { name: "save_walkthrough", arguments: {} });
  assert.match(popup.sent.at(-1).error, /read-only/);
  await popup.message("flow/select", select(s));
  assert.equal(host.reader.sent.at(-1).type, "codepath.flow.select");
  await popup.message("flow/ready", { view: "view-B" });
  await assert.rejects(
    () => controller.publish(host.reader, s),
    /closed or changed/
  );
  const count = host.reader.sent.length;
  await popup.message("flow/select", select(s));
  assert.equal(
    host.reader.sent.length,
    count,
    "Old document cannot forward a click"
  );
  const second = await controller.open(host.reader);
  assert.notEqual(first.lease, second.lease);
  await controller.close(host.reader, {
    session: first.session,
    lease: first.lease,
  });
  assert.equal(
    popup.disposed,
    false,
    "Late close result cannot dispose a newer lease"
  );
  await controller.close(host.reader, {
    session: second.session,
    lease: second.lease,
  });
  assert.equal(popup.disposed, true);
});
test("Reader disposal during native opening cannot publish or create a late Flow panel", async () => {
  const host = fakeHost();
  let finish;
  host.api.commands.getCommands = () =>
    new Promise((r) => {
      finish = r;
    });
  const { createFlowWindow } = await adapter(host),
    c = createFlowWindow(() => "", []),
    pending = c.open(host.reader);
  host.reader.dispose();
  finish(["workbench.action.newEmptyEditorWindow"]);
  await assert.rejects(pending, /closed/);
  assert.equal(host.panels.length, 0);
  assert.equal(host.executed.length, 0);
});
