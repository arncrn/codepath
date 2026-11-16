import * as vscode from "vscode";
import crypto from "node:crypto";
import {
  flowState,
  record,
  type FlowWindowState,
} from "../ui/flow-window-wire.js";

// Native adapter: create an EMPTY auxiliary window, then put only our Flow in
// its newly observed group. Never move whichever user editor happens to be active.
export function createFlowWindow(
  html: (panel: vscode.WebviewPanel) => string,
  roots: vscode.Uri[]
) {
  type Entry = {
    id: string;
    reader: vscode.WebviewPanel;
    panel: vscode.WebviewPanel;
    state: FlowWindowState | null;
    group?: vscode.TabGroup;
    life: symbol;
    lease: string;
    viewer?: string;
  };
  let entry: Entry | null = null;
  let opening: Promise<Entry> | null = null;
  function admit(current: Entry) {
    if (entry !== current) throw Error("Flow window closed while opening.");
    current.lease = crypto.randomUUID();
    return {
      session: current.id,
      lease: current.lease,
      viewer: current.viewer,
      separateWindow: !!current.group,
    };
  }
  let generation = Symbol();
  function retire(current: Entry) {
    if (entry !== current) return false;
    entry = null;
    generation = Symbol();
    void current.reader.webview.postMessage({
      type: "codepath.flow.closed",
      session: current.id,
    });
    return true;
  }
  async function remove(current: Entry) {
    if (!retire(current)) return;
    current.panel.dispose();
    // Never close a group: the user may have added another editor meanwhile.
    // VS Code manages the lifetime of its empty auxiliary window.
  }
  async function open(reader: vscode.WebviewPanel) {
    if (entry?.reader === reader) {
      entry.panel.reveal(entry.panel.viewColumn);
      return admit(entry);
    }
    if (opening) {
      const current = await opening;
      if (current.reader !== reader)
        throw Error("Reader changed while opening Flow.");
      return admit(current);
    }
    const life = (generation = Symbol());
    const work = async () => {
      let cancelled = false;
      const disposal = reader.onDidDispose(() => {
        cancelled = true;
      });
      let group: vscode.TabGroup | undefined;
      try {
        const commands = await vscode.commands.getCommands(true);
        if (cancelled || generation !== life)
          throw Error("Reader closed before Flow opened.");
        if (commands.includes("workbench.action.newEmptyEditorWindow")) {
          const before = new Set(vscode.window.tabGroups.all);
          await vscode.commands.executeCommand(
            "workbench.action.newEmptyEditorWindow"
          );
          let added = vscode.window.tabGroups.all.filter((g) => !before.has(g));
          const until = Date.now() + 3000;
          while (
            !added.length &&
            !cancelled &&
            generation === life &&
            Date.now() < until
          ) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            added = vscode.window.tabGroups.all.filter((g) => !before.has(g));
          }
          if (added.length === 1 && added[0].tabs.length === 0)
            group = added[0];
        }
        if (cancelled || generation !== life) {
          throw Error("Reader closed before Flow opened.");
        }
        const panel = vscode.window.createWebviewPanel(
          "codepath.flow",
          "Codepath · Flow",
          group?.viewColumn ?? vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: roots,
          }
        );
        const current: Entry = {
          id: crypto.randomUUID(),
          reader,
          panel,
          state: null,
          group,
          life,
          lease: crypto.randomUUID(),
        };
        entry = current;
        panel.onDidDispose(() => {
          retire(current);
        });
        panel.webview.onDidReceiveMessage(async (message: unknown) => {
          if (
            entry !== current ||
            generation !== life ||
            !record(message) ||
            message.type !== "codepath.request" ||
            typeof message.id !== "string" ||
            message.id.length > 100
          )
            return;
          try {
            if (
              message.route === "flow/ready" ||
              message.route === "flow/ping"
            ) {
              const body = message.body;
              if (
                !record(body) ||
                typeof body.view !== "string" ||
                !body.view.length ||
                body.view.length > 100
              )
                throw Error("Invalid Flow view lifetime.");
              if (message.route === "flow/ready") {
                if (current.viewer !== body.view) current.state = null;
                current.viewer = body.view;
              } else if (current.viewer !== body.view)
                throw Error("Flow view changed.");
              if (entry === current)
                await reader.webview.postMessage({
                  type:
                    message.route === "flow/ready"
                      ? "codepath.flow.ready"
                      : "codepath.flow.ping",
                  session: current.id,
                  view: body.view,
                });
            } else if (message.route === "flow/close") {
              if (!record(message.body) || message.body.view !== current.viewer)
                throw Error("Flow view changed.");
              await remove(current);
              return;
            } else if (message.route === "flow/select") {
              const body = message.body;
              if (
                !record(body) ||
                body.type !== "codepath.flow.select" ||
                body.session !== current.id ||
                body.viewer !== current.viewer ||
                body.epoch !== current.state?.epoch ||
                body.root !== current.state?.root ||
                typeof body.nodeId !== "string" ||
                body.nodeId.length > 100
              )
                throw Error("Flow view changed; reopen it from the reader.");
              await reader.webview.postMessage(body);
            } else throw Error("Flow windows are read-only.");
            if (entry === current && generation === life)
              await panel.webview.postMessage({
                type: "codepath.response",
                id: message.id,
                result: null,
              });
          } catch (error) {
            if (entry === current && generation === life)
              await panel.webview.postMessage({
                type: "codepath.response",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              });
          }
        });
        panel.webview.html = html(panel);
        return current;
      } finally {
        disposal.dispose();
      }
    };
    const pending = work();
    opening = pending;
    try {
      return admit(await pending);
    } finally {
      if (opening === pending) opening = null;
    }
  }
  return {
    open,
    async publish(reader: vscode.WebviewPanel, body: unknown) {
      const current = entry;
      if (
        !current ||
        current.reader !== reader ||
        !record(body) ||
        body.session !== current.id ||
        body.viewer !== current.viewer
      )
        throw Error("Flow window closed or changed. Reopen it.");
      if (
        body.type === "codepath.flow.heartbeat" &&
        body.root === current.state?.root &&
        body.epoch === current.state?.epoch
      ) {
        await current.panel.webview.postMessage(body);
        return;
      }
      if (!flowState(body) || JSON.stringify(body).length > 9 * 1024 * 1024)
        throw Error("Invalid Flow display snapshot.");
      current.state = body;
      current.panel.title = "Flow · " + (body.walkthrough?.title ?? "Codepath");
      await current.panel.webview.postMessage(body);
    },
    async close(reader: vscode.WebviewPanel, body: unknown) {
      if (
        entry?.reader === reader &&
        record(body) &&
        body.session === entry.id &&
        body.lease === entry.lease
      )
        await remove(entry);
    },
    disconnect(reader: vscode.WebviewPanel) {
      if (entry?.reader === reader) void remove(entry);
    },
    dispose() {
      generation = Symbol();
      if (entry) void remove(entry);
    },
  };
}
