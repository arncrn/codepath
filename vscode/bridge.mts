import path from "node:path";
import crypto from "node:crypto";
import { tools } from "../tools.mjs";
import type {
  SourceIndex,
  ToolClient,
  ToolName,
  ToolArgs,
  AppConfig,
} from "../types.mjs";
const toolNames = new Set(tools.map((t) => t.name));

export function selectionSource(
  index: Pick<SourceIndex, "files">,
  file: string,
  { startLine, endLine }: { startLine: number; endLine: number }
) {
  const entry = index.files.find((f) => f.file === file);
  if (!entry)
    throw Error(
      "This file is not indexed. Codepath supports saved JS, TS, React and Go source files."
    );
  if (
    !Number.isInteger(entry.lineCount) ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > entry.lineCount
  )
    throw Error("Selection is outside the saved file.");
  return {
    title: path.posix.basename(file) + " · lines " + startLine + "–" + endLine,
    source: { file, startLine, endLine },
  };
}

// No token or arbitrary URL crosses into the webview. All writes still use the service.
export async function dispatchWebviewRequest(
  service: ToolClient,
  route: string,
  body?: unknown
) {
  const input = body as
    | {
        name: ToolName;
        arguments?: ToolArgs[ToolName];
        walkthroughId: string;
        stepId: string;
      }
    | undefined;
  if (route === "/api/state" && body === undefined)
    return service.request(route);
  if (route === "/api/call" && input && toolNames.has(input.name)) {
    if (JSON.stringify(body).length > 2 * 1024 * 1024)
      throw Error("Request exceeds 2 MiB.");
    return service.call(input.name, input.arguments ?? {});
  }
  if (route === "open-source") {
    const walk = await service.call("get_walkthrough", {
      id: input?.walkthroughId ?? "",
    });
    const step = walk.steps.find((s) => s.id === input?.stepId);
    if (!step?.code || step.error)
      throw Error(step?.error || "Source is no longer available.");
    return {
      file: step.code.file,
      startLine: step.code.startLine,
      endLine: step.code.endLine,
    };
  }
  throw Error("Unsupported webview request.");
}

// Separate from the service protocol: the host supplies the session root and
// workspaceState. A webview cannot choose a storage key, root or arbitrary data.
export async function dispatchReadingContext(
  state: {
    get(key: string): unknown;
    update(key: string, value: unknown): Thenable<void>;
  },
  root: string,
  route: string,
  body?: unknown
) {
  const key = "codepath.reading-context.v1:" + root;
  const validate = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const v = value as Record<string, unknown>;
    const fields = ["version", "walkthroughId", "stepId", "tab", "focusNonce"];
    const id = (s: unknown) =>
      s === null || (typeof s === "string" && s.length > 0 && s.length <= 200);
    if (
      Object.keys(v).length !== fields.length ||
      Object.keys(v).some((k) => !fields.includes(k)) ||
      v.version !== 1 ||
      !id(v.walkthroughId) ||
      !id(v.stepId) ||
      !id(v.focusNonce) ||
      (v.tab !== "data" &&
        v.tab !== "notes" &&
        v.tab !== "variables" &&
        v.tab !== "flow")
    )
      return null;
    return {
      version: 1,
      walkthroughId: v.walkthroughId,
      stepId: v.stepId,
      tab: v.tab === "data" ? "notes" : v.tab,
      focusNonce: v.focusNonce,
    };
  };
  if (route === "reading-context/get" && body === undefined)
    return validate(state.get(key));
  if (route === "reading-context/set") {
    const value = validate(body);
    if (!value) throw Error("Invalid reading context.");
    await state.update(key, value);
    return null;
  }
  throw Error("Unsupported reading context request.");
}

export function webviewHtml(
  template: string,
  {
    styleUri,
    themeUri,
    scriptUri,
    cspSource,
    config,
  }: {
    styleUri: string;
    themeUri: string;
    scriptUri: string;
    cspSource: string;
    config: Omit<AppConfig, "demo">;
  }
) {
  const nonce = crypto.randomBytes(24).toString("hex");
  const attr = (s: string) =>
    String(s).replace(
      /[&"<>]/g,
      (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!
    );
  const csp =
    "default-src 'none'; script-src 'nonce-" +
    nonce +
    "'; style-src " +
    cspSource +
    "; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return template
    .replace(
      "<head>",
      '<head><meta http-equiv="Content-Security-Policy" content="' +
        attr(csp) +
        '">'
    )
    .replace('href="/style.css"', 'href="' + attr(styleUri) + '"')
    .replace(
      "</head>",
      '<link rel="stylesheet" href="' + attr(themeUri) + '"></head>'
    )
    .replace(
      'src="/ui.js"',
      'nonce="' + nonce + '" src="' + attr(scriptUri) + '"'
    )
    .replace(
      "<!--CONFIG-->",
      '<script nonce="' +
        nonce +
        '">window.CODEPATH_CONFIG=' +
        JSON.stringify({ ...config, host: "vscode", demo: false }).replaceAll(
          "<",
          "\\u003c"
        ) +
        ";</script>"
    );
}
