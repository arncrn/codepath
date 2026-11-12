import { parseAttachments } from "./annotations.mjs";
import { currentSourceAttachment } from "./source-bindings.mjs";
import type {
  FlowEdge,
  FlowNode,
  FlowState,
  Step,
  WalkthroughGraph,
} from "./types.mjs";

const nodeKinds = new Set([
  "entry",
  "process",
  "decision",
  "join",
  "call",
  "exit",
  "unresolved",
]);
const edgeKinds = new Set([
  "next",
  "true",
  "false",
  "call",
  "return",
  "loop",
  "recursion",
  "unresolved",
]);
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error("Flow: " + message);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  need(
    !!value && typeof value === "object" && !Array.isArray(value),
    "expected an object."
  );
}
function text(
  value: unknown,
  max: number,
  empty = false
): asserts value is string {
  need(
    typeof value === "string" &&
      (empty || value.trim().length > 0) &&
      value.length <= max,
    "missing or oversized text."
  );
}
function id(value: unknown): asserts value is string {
  need(
    typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value),
    "invalid identifier."
  );
}
function fingerprint(value: unknown): asserts value is string {
  need(
    typeof value === "string" && /^[a-f0-9]{20}$/.test(value),
    "invalid source fingerprint."
  );
}
// Structural validation is deliberately separate from current-source admission:
// removing a card leaves a saved graph stale, not un-loadable or silently pruned.
export function parseWalkthroughFlow(value: unknown): WalkthroughGraph {
  object(value);
  need(
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 256 * 1024,
    "graph exceeds 256 KiB."
  );
  need(value.version === 1, "unsupported graph version.");
  text(value.summary, 1200);
  need(
    Array.isArray(value.nodes) &&
      value.nodes.length > 0 &&
      value.nodes.length <= 120,
    "provide 1–120 nodes."
  );
  need(
    Array.isArray(value.edges) && value.edges.length <= 240,
    "provide at most 240 edges."
  );
  const ids = new Set<string>();
  const nodes = value.nodes.map((n: unknown): FlowNode => {
    object(n);
    id(n.id);
    id(n.stepId);
    fingerprint(n.sourceHash);
    text(n.label, 300);
    need(!ids.has(n.id), "duplicate node identifier.");
    ids.add(n.id);
    need(
      typeof n.kind === "string" && nodeKinds.has(n.kind),
      "invalid node kind."
    );
    const attachment = parseAttachments([n.attachment])[0];
    // Relocation belongs to Notes, never authored graph identity.
    need(
      attachment.sourceExcerpt === undefined,
      "graph bindings cannot use relocation context."
    );
    return {
      id: n.id,
      stepId: n.stepId,
      sourceHash: n.sourceHash,
      label: n.label,
      kind: n.kind as FlowNode["kind"],
      attachment,
    };
  });
  const seen = new Set<string>();
  const edges = value.edges.map((e: unknown): FlowEdge => {
    object(e);
    id(e.from);
    id(e.to);
    text(e.label, 200, true);
    text(e.basis, 1200);
    need(ids.has(e.from) && ids.has(e.to), "unknown edge endpoint.");
    need(
      typeof e.kind === "string" && edgeKinds.has(e.kind),
      "invalid edge kind."
    );
    const key = JSON.stringify([e.from, e.to, e.kind]);
    need(!seen.has(key), "duplicate edge.");
    seen.add(key);
    const origin = nodes.find((n) => n.id === e.from)!;
    if (e.kind === "true" || e.kind === "false")
      need(origin.kind === "decision", "branch origin must be a decision.");
    if (e.kind === "call" || e.kind === "recursion")
      need(origin.kind === "call", "call origin must be a call node.");
    if (e.kind === "unresolved")
      need(
        origin.kind === "unresolved" ||
          nodes.find((n) => n.id === e.to)!.kind === "unresolved",
        "unresolved edge must identify an unresolved node."
      );
    return {
      from: e.from,
      to: e.to,
      kind: e.kind as FlowEdge["kind"],
      label: e.label,
      basis: e.basis,
    };
  });
  for (const n of nodes)
    if (n.kind === "decision") {
      const branches = edges.filter((e) => e.from === n.id);
      need(
        branches.filter((e) => e.kind === "true").length === 1 &&
          branches.filter((e) => e.kind === "false").length === 1,
        "each decision needs one true and one false edge."
      );
      need(
        branches.find((e) => e.kind === "true")!.to !==
          branches.find((e) => e.kind === "false")!.to,
        "decision branches must have distinct destinations."
      );
    }
  return { version: 1, summary: value.summary, nodes, edges };
}
// Labels are data, never Mermaid identifiers, directives, HTML, links or Markdown.
function label(value: string) {
  return Array.from(value, (c) =>
    /[a-zA-Z0-9 ]/.test(c) ? c : `#${c.codePointAt(0)};`
  ).join("");
}
export function projectWalkthroughFlow(
  graph: WalkthroughGraph | undefined,
  steps: Step[]
): FlowState {
  if (!graph)
    return {
      status: "absent",
      message: "Flow has not been authored for this walkthrough.",
    };
  const invalid = graph.nodes.filter((node) => {
    const step = steps.find((step) => step.id === node.stepId);
    return (
      !step?.code ||
      !!step.error ||
      step.code.hash !== node.sourceHash ||
      !currentSourceAttachment(node.attachment, step.code)
    );
  });
  if (invalid.length)
    return {
      status: "stale",
      message:
        "Flow source or linked cards changed. Ask your authoring agent to review the flow; no connections have been reattached.",
    };
  const names = new Map(graph.nodes.map((n, i) => [n.id, `s${i}`]));
  const lines = ["flowchart TB"];
  for (const n of graph.nodes) {
    const caption = label(n.label);
    const shapes: Record<FlowNode["kind"], string> = {
      entry: `(["${caption}"])`,
      exit: `(["${caption}"])`,
      process: `["${caption}"]`,
      decision: `{"${caption}"}`,
      join: `(("${caption}"))`,
      call: `[["${caption}"]]`,
      unresolved: `["${label("Unresolved: ") + caption}"]`,
    };
    lines.push(`${names.get(n.id)}${shapes[n.kind]}`);
  }
  for (const e of graph.edges)
    lines.push(
      `${names.get(e.from)} ${e.kind === "unresolved" ? "-.-" : "--"}>|"${label(e.kind + (e.label ? ": " + e.label : ""))}"| ${names.get(e.to)}`
    );
  return {
    status: "current",
    message: graph.summary,
    definition: lines.join("\n"),
    nodes: graph.nodes.map((n) => ({
      id: names.get(n.id)!,
      stepId: n.stepId,
      label: n.label,
      sourceHash: n.sourceHash,
      attachment: { ...n.attachment },
    })),
  };
}
export function admitWalkthroughFlow(
  value: unknown,
  steps: Step[]
): WalkthroughGraph {
  const graph = parseWalkthroughFlow(value);
  need(
    projectWalkthroughFlow(graph, steps).status === "current",
    "source or linked cards changed; read current code and exact selections again."
  );
  return graph;
}
