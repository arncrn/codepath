import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startProjectService } from "../service.mjs";
import {
  selectionSource,
  dispatchWebviewRequest,
  dispatchReadingContext,
  webviewHtml,
} from "./bridge.mjs";
import { followReference } from "./definition.mjs";

import type {
  ProjectService,
  ReferenceContext,
  DefinitionLocation,
} from "../types.mjs";
import { errorMessage } from "../types.mjs";
interface Session {
  service: ProjectService;
  folder: vscode.WorkspaceFolder;
  panel: vscode.WebviewPanel | null;
}
const sessions = new Map<string, Promise<Session>>();
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Codepath");
  context.subscriptions.push(output);
  const report = (e: unknown) => {
    output.appendLine(e instanceof Error ? e.stack || e.message : String(e));
    vscode.window.showErrorMessage("Codepath: " + errorMessage(e));
  };
  async function folderFor(editor: vscode.TextEditor | undefined) {
    if (!vscode.workspace.isTrusted)
      throw Error("Trust this workspace before opening Codepath.");
    const current =
      editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (f) => f.uri.scheme === "file"
    );
    if (current?.uri.scheme === "file") return current;
    if (!folders.length)
      throw Error(
        "Open a local folder first. Codepath does not support virtual workspaces."
      );
    if (folders.length === 1) return folders[0];
    const choice = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder,
      })),
      { placeHolder: "Choose a folder for Codepath" }
    );
    return choice?.folder;
  }
  async function getSession(folder: vscode.WorkspaceFolder): Promise<Session> {
    const root = fs.realpathSync(folder.uri.fsPath);
    if (!sessions.has(root)) {
      const pending = startProjectService(root, {
        assetsRoot: path.join(context.extensionPath, "dist"),
        reuse: true,
      })
        .then(async (service) => {
          if (
            !service.owned &&
            (await service.request("/api/state")).capabilities
              ?.onDemandSource !== true
          )
            throw Error(
              "An older Codepath service owns this folder. Close its owning Codepath host, then reopen Codepath to use on-demand indexing. The existing service and walkthrough data were left untouched."
            );
          output.appendLine(
            (service.owned ? "Started " : "Connected to ") +
              service.url +
              " · " +
              root
          );
          return { service, folder, panel: null };
        })
        .catch((e) => {
          sessions.delete(root);
          throw e;
        });
      sessions.set(root, pending);
    }
    return sessions.get(root)!;
  }
  async function followSymbol(session: Session, context: ReferenceContext) {
    const result = await followReference(session.service, context, {
      findDefinitions: async (position) => {
        const uri = vscode.Uri.joinPath(
          session.folder.uri,
          ...position.file.split("/")
        );
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty)
          throw Error(
            "Save the source file before following a symbol from its saved card."
          );
        let timer: ReturnType<typeof setTimeout> | undefined,
          definitions: (vscode.Location | vscode.LocationLink)[] = [];
        try {
          definitions =
            (await Promise.race([
              vscode.commands.executeCommand<
                (vscode.Location | vscode.LocationLink)[]
              >(
                "vscode.executeDefinitionProvider",
                uri,
                new vscode.Position(position.line - 1, position.column)
              ),
              new Promise<[]>((resolve) => {
                timer = setTimeout(() => resolve([]), 5000);
              }),
            ])) ?? [];
        } catch (e) {
          output.appendLine(
            "Definition lookup unavailable: " + errorMessage(e)
          );
        } finally {
          clearTimeout(timer);
        }
        const locations: DefinitionLocation[] = [];
        let external = false;
        for (const definition of definitions) {
          const target =
              "targetUri" in definition ? definition.targetUri : definition.uri,
            range =
              "targetRange" in definition
                ? definition.targetRange
                : definition.range;
          if (!target || !range) continue;
          if (target.scheme !== "file") {
            external = true;
            continue;
          }
          let file;
          try {
            file = path
              .relative(session.service.root, fs.realpathSync(target.fsPath))
              .split(path.sep)
              .join("/");
          } catch {
            continue;
          }
          if (
            file === ".." ||
            file.startsWith("../") ||
            path.isAbsolute(file)
          ) {
            external = true;
            continue;
          }
          if (
            vscode.workspace.textDocuments.some(
              (d) => d.uri.toString() === target.toString() && d.isDirty
            )
          )
            throw Error(
              "Save the definition file before adding its source to the walkthrough."
            );
          locations.push({
            file,
            startLine: range.start.line + 1,
            endLine:
              range.end.line +
              1 -
              (range.end.character === 0 && range.end.line > range.start.line
                ? 1
                : 0),
          });
        }
        return { locations, external };
      },
      choose: async (candidates, name) => {
        const choice = await vscode.window.showQuickPick(
          candidates.map((target) => ({
            label: target.title,
            description: target.source.file,
            detail: target.explanation,
            target,
          })),
          {
            placeHolder:
              "Multiple definitions for " + name + " — choose the intended one",
          }
        );
        return choice?.target;
      },
    });
    if (result.message)
      vscode.window.showInformationMessage("Codepath: " + result.message);
    if (result.stepId)
      await session.panel?.webview.postMessage({ type: "codepath.refresh" });
    return result;
  }
  function show(session: Session) {
    if (session.panel) {
      session.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "codepath.walkthrough",
      "Codepath · " + path.basename(session.service.root),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "dist")),
        ],
      }
    );
    session.panel = panel;
    panel.onDidDispose(() => {
      session.panel = null;
    });
    panel.webview.onDidReceiveMessage(async (message) => {
      if (
        message?.type !== "codepath.request" ||
        typeof message.id !== "string" ||
        message.id.length > 100
      )
        return;
      try {
        const result =
          message.route === "reading-context/get" ||
          message.route === "reading-context/set"
            ? await dispatchReadingContext(
                context.workspaceState,
                session.service.root,
                message.route,
                message.body
              )
            : message.route === "follow-reference"
              ? await followSymbol(session, message.body)
              : await dispatchWebviewRequest(
                  session.service,
                  message.route,
                  message.body
                );
        if (message.route === "open-source") {
          // Resolve through the indexed walkthrough, never an arbitrary webview filename.
          const uri = vscode.Uri.joinPath(
            session.folder.uri,
            ...(result as DefinitionLocation).file.split("/")
          );
          const document = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
          });
          const source = result as DefinitionLocation;
          const range = new vscode.Range(
            source.startLine - 1,
            0,
            source.endLine - 1,
            document.lineAt(source.endLine - 1).text.length
          );
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(
            range,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
          );
        }
        await panel.webview.postMessage({
          type: "codepath.response",
          id: message.id,
          result,
        });
      } catch (e) {
        await panel.webview.postMessage({
          type: "codepath.response",
          id: message.id,
          error: errorMessage(e),
        });
      }
    });
    panel.webview.html = webviewHtml(
      fs.readFileSync(path.join(context.extensionPath, "dist/ui.html"), "utf8"),
      {
        cspSource: panel.webview.cspSource,
        styleUri: panel.webview
          .asWebviewUri(
            vscode.Uri.file(path.join(context.extensionPath, "dist/style.css"))
          )
          .toString(),
        themeUri: panel.webview
          .asWebviewUri(
            vscode.Uri.file(path.join(context.extensionPath, "dist/vscode.css"))
          )
          .toString(),
        scriptUri: panel.webview
          .asWebviewUri(
            vscode.Uri.file(path.join(context.extensionPath, "dist/ui.js"))
          )
          .toString(),
        config: {
          root: session.service.root,
          toolRoot: path.join(context.extensionPath, "dist"),
          backend: "node",
        },
      }
    );
  }
  async function open() {
    const folder = await folderFor(vscode.window.activeTextEditor);
    if (!folder) return;
    show(await getSession(folder));
  }
  async function startFromSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file")
      throw Error(
        "Open a saved source file and select code, or place the cursor on the line to explore."
      );
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder)
      throw Error("The source file must belong to an open workspace folder.");
    await folderFor(editor); // Enforce Workspace Trust before touching project storage.
    if (editor.document.isDirty) {
      const answer = await vscode.window.showWarningMessage(
        "Codepath reads saved source. Save this file before continuing?",
        "Save and continue"
      );
      if (answer !== "Save and continue") return;
      if (!(await editor.document.save()))
        throw Error("Could not save the source file.");
    }
    const selection = editor.selection;
    const session = await getSession(folder),
      root = session.service.root;
    const file = path
      .relative(root, fs.realpathSync(editor.document.uri.fsPath))
      .split(path.sep)
      .join("/");
    const inspected = await session.service.call("inspect_source", { file });
    const step = selectionSource({ files: [inspected] }, file, {
      startLine: selection.start.line + 1,
      endLine:
        selection.end.line +
        1 -
        (!selection.isEmpty && selection.end.character === 0 ? 1 : 0),
    });
    const id = crypto.randomUUID();
    const walk = await session.service.call("save_walkthrough", {
      title: "Explore " + step.title,
      description:
        "Right-click a source identifier to follow its definition. Use Add step for an explicit cross-layer connection.",
      steps: [
        {
          id,
          ...step,
          evidence: "inferred",
          explanation: "",
        },
      ],
    });
    await session.service.call("focus_step", {
      walkthroughId: walk.id,
      stepId: id,
    });
    show(session);
    await session.panel!.webview.postMessage({ type: "codepath.refresh" });
    return { walkthroughId: walk.id, stepId: id };
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("codepath.open", () =>
      open().catch(report)
    ),
    vscode.commands.registerCommand("codepath.startFromSelection", () =>
      startFromSelection().catch(report)
    )
  );
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    20
  );
  status.text = "$(list-ordered) Codepath";
  status.tooltip = "Open Codepath walkthroughs";
  status.command = "codepath.open";
  status.show();
  context.subscriptions.push(status);
}

export async function deactivate() {
  await Promise.allSettled(
    [...sessions.values()].map(async (pending) => {
      const session = await pending;
      session.panel?.dispose();
      await session.service.close();
    })
  );
  sessions.clear();
}
