import fs from "node:fs";
import path from "node:path";
import type { ToolName, ToolArgs, ToolResults } from "./types.mjs";
export async function callTool<N extends ToolName>(
  root: string,
  name: N,
  args: ToolArgs[N]
): Promise<ToolResults[N]> {
  let c;
  try {
    c = JSON.parse(
      fs.readFileSync(path.join(root, ".codepaths/connection.json"), "utf8")
    );
  } catch {
    throw Error("Start Codepath for this project first.");
  }
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw Error("Invalid local connection.");
  const presentationRequest =
    (name === "add_reviewed_note" || name === "review_note") &&
    args &&
    typeof args === "object" &&
    (("variableName" in args && args.variableName !== undefined) ||
      ("archived" in args && args.archived !== undefined));
  const sourceRequest = [
    "inspect_source",
    "list_source_files",
    "find_symbols",
    "read_source",
    "search_source",
    "follow_calls",
    "resolve_reference",
  ].includes(name);
  const validationRequest = name === "validate_walkthrough";
  if (presentationRequest || sourceRequest || validationRequest) {
    const response = await fetch("http://127.0.0.1:" + c.port + "/api/state", {
      headers: { "X-Codepath-Token": c.token },
      signal: AbortSignal.timeout(15000),
    });
    const overview: unknown = await response.json();
    if (
      !response.ok ||
      !overview ||
      typeof overview !== "object" ||
      !("root" in overview) ||
      overview.root !== fs.realpathSync(root) ||
      !("capabilities" in overview) ||
      !overview.capabilities ||
      typeof overview.capabilities !== "object" ||
      (validationRequest
        ? !("authoringValidation" in overview.capabilities) ||
          overview.capabilities.authoringValidation !== true
        : sourceRequest
          ? !("onDemandSource" in overview.capabilities) ||
            overview.capabilities.onDemandSource !== true
          : !("notePresentation" in overview.capabilities) ||
            overview.capabilities.notePresentation !== true)
    )
      throw Error(
        validationRequest
          ? "Reload VS Code, then reopen Codepath to validate generated walkthroughs. No readiness result was reported."
          : sourceRequest
            ? "Reload VS Code, then reopen Codepath to use on-demand source indexing. No source request was sent."
            : "Reload VS Code, then reopen Codepath to save variable explanations or archived notes. No note update was sent."
      );
  }
  const r = await fetch("http://127.0.0.1:" + c.port + "/api/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codepath-Token": c.token,
    },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await r.json();
  if (!r.ok)
    throw Error((value as { error?: string }).error || "Request failed.");
  return value as ToolResults[N];
}
