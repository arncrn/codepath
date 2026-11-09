import readline from "node:readline";
import path from "node:path";
import { tools } from "./tools.mjs";
import { callTool } from "./client.mjs";
import type { ToolName, ToolArgs } from "./types.mjs";
import { errorMessage } from "./types.mjs";
const args = process.argv.slice(2),
  option = (n: string, d = "") =>
    args.includes(n) ? args[args.indexOf(n) + 1] : d,
  root = path.resolve(option("--root", process.cwd()));
if (args.includes("--call")) {
  try {
    console.log(
      JSON.stringify(
        await callTool(
          root,
          option("--call") as ToolName,
          JSON.parse(option("--args", "{}"))
        ),
        null,
        2
      )
    );
  } catch (e) {
    console.error(errorMessage(e));
    process.exitCode = 1;
  }
} else {
  const send = (value: Record<string, unknown>) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  for await (const line of readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    let m: {
      id?: string | number | null;
      method?: string;
      params?: {
        protocolVersion?: string;
        name: ToolName;
        arguments?: ToolArgs[ToolName];
      };
    };
    try {
      m = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (m.id === undefined) continue;
    const id = m.id;
    if (m.method === "initialize")
      send({
        id,
        result: {
          protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(
            m.params?.protocolVersion ?? ""
          )
            ? m.params!.protocolVersion
            : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "codepath-prototype", version: "0.7.1" },
          instructions:
            "Read source before mapping paths. Keep a brief overall purpose in the card explanation. Add block/function-call explanations to Notes. Use add_reviewed_note or review_note with an explicit variableName and whole-identifier source attachments for individual entries in Variables; never guess their category from prose. Archive obsolete duplicate notes without deleting their IDs/history. Do not duplicate the card explanation in Notes. For code review explain behavior before versus after at each relevant level. Keep setup history and separate review findings out of code explanations. Mark uncertain connections inferred. Never describe an illustrative run as observed execution.",
        },
      });
    else if (m.method === "ping") send({ id, result: {} });
    else if (m.method === "tools/list") send({ id, result: { tools } });
    else if (m.method === "tools/call") {
      try {
        const value = await callTool(
          root,
          m.params!.name,
          (m.params!.arguments ?? {}) as ToolArgs[ToolName]
        );
        send({
          id,
          result: { content: [{ type: "text", text: JSON.stringify(value) }] },
        });
      } catch (e) {
        send({
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: errorMessage(e) }],
          },
        });
      }
    } else send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
