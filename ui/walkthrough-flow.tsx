import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import type { Walkthrough } from "../types.mjs";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";

const svgNamespace = "http://www.w3.org/2000/svg";
const tags = new Set([
  "svg",
  "g",
  "defs",
  "marker",
  "path",
  "rect",
  "polygon",
  "polyline",
  "line",
  "circle",
  "ellipse",
  "text",
  "tspan",
  "title",
  "desc",
]);
const attributes = new Set([
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "transform",
  "d",
  "points",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "dx",
  "dy",
  "rx",
  "ry",
  "r",
  "cx",
  "cy",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "orient",
  "refX",
  "refY",
  "text-anchor",
  "dominant-baseline",
  "textLength",
  "lengthAdjust",
]);

// Reconstruct a passive SVG; do not insert Mermaid's HTML string. No style,
// foreignObject, image, href, event handlers or library bindFunctions survive.
// Static, locally bundled CSS supplies all diagram styling under the host CSP.
function passiveSvg(markup: string): SVGElement {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror"))
    throw Error("Invalid flow diagram.");
  const ids = new Set(
    Array.from(root.querySelectorAll("[id]"), (node) => node.id)
  );
  function copy(node: Element): SVGElement {
    const element = document.createElementNS(svgNamespace, node.localName);
    for (const attribute of Array.from(node.attributes)) {
      if (attributes.has(attribute.name))
        element.setAttribute(attribute.name, attribute.value);
      else if (
        ["marker-end", "marker-start", "marker-mid"].includes(attribute.name) &&
        /^url\(#[a-zA-Z0-9_-]+\)$/.test(attribute.value) &&
        ids.has(attribute.value.slice(5, -1))
      )
        element.setAttribute(attribute.name, attribute.value);
    }
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE)
        element.append(document.createTextNode(child.textContent ?? ""));
      else if (
        child instanceof Element &&
        child.namespaceURI === svgNamespace &&
        tags.has(child.localName)
      )
        element.append(copy(child));
    }
    return element;
  }
  const svg = copy(root);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Source-bound behavioral explanation flow");
  return svg;
}

let nextRender = 0;
// Mermaid has shared mutable configuration. Serialize actual rendering, skipping
// obsolete queued jobs before doing work; every mounted view also guards replies.
let rendering: Promise<unknown> = Promise.resolve();
function Diagram({
  source,
  edges,
  nodes,
  selectNode,
}: {
  source: string;
  edges: number;
  nodes: NonNullable<Walkthrough["flowState"]["nodes"]>;
  selectNode: (id: string) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const action = useRef(selectNode);
  action.current = selectNode;
  const mappings = useRef(nodes);
  mappings.current = nodes;
  const [status, setStatus] = useState("Rendering flow…");
  const [fit, setFit] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      rendering = rendering
        .catch(() => {})
        .then(async () => {
          if (cancelled) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
            suppressErrorRendering: true,
            // Admission rejects oversized graphs; no display truncation.
            maxTextSize: source.length + 1,
            maxEdges: edges + 1,
            flowchart: { htmlLabels: false, useMaxWidth: false },
          });
          const renderId = `walkthrough-flow-${++nextRender}`;
          const { svg } = await mermaid.render(renderId, source);
          if (cancelled || !target.current) return;
          const passive = passiveSvg(svg);
          // The library never supplies handlers or links. Only generated IDs in
          // the validated host projection receive trusted accessible actions.
          for (const element of passive.querySelectorAll<SVGElement>(".node")) {
            const prefix = renderId + "-flowchart-";
            const id = element.id.startsWith(prefix)
              ? /^(s\d+)-\d+$/.exec(element.id.slice(prefix.length))?.[1]
              : undefined;
            const mapping = mappings.current.find((node) => node.id === id);
            if (!mapping) continue;
            element.setAttribute("tabindex", "0");
            element.setAttribute("role", "button");
            element.setAttribute("aria-label", "Show card: " + mapping.label);
            element.setAttribute("data-flow-step", mapping.stepId);
            element.addEventListener("click", () => {
              if (!cancelled) action.current(mapping.id);
            });
            element.addEventListener("keydown", (event) => {
              if (!cancelled && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                action.current(mapping.id);
              }
            });
          }
          target.current.replaceChildren(passive);
          setStatus("");
        })
        .catch(() => {
          if (!cancelled)
            setStatus(
              "Flow could not be rendered. The ordered cards remain available."
            );
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [source, edges]);
  return (
    <>
      {status && <p role="status">{status}</p>}
      <button type="button" aria-pressed={fit} onClick={() => setFit(!fit)}>
        {fit ? "Actual size" : "Fit diagram"}
      </button>
      <div className={"walkthrough-flow" + (fit ? " fit" : "")} ref={target} />
    </>
  );
}

export function WalkthroughFlow({
  walkthrough,
  hidden,
  selectCard,
}: {
  walkthrough: Walkthrough | null;
  hidden: boolean;
  selectCard: (focus: FlowSourceFocus) => void;
}) {
  const latest = useRef(walkthrough);
  latest.current = walkthrough;
  const flow = walkthrough?.flowState;
  const source = flow?.definition ?? "";
  function selectNode(id: string) {
    const current = latest.current;
    // Re-check latest post-poll state, not the card list captured before await.
    if (
      !current ||
      current.flowState.status !== "current" ||
      current.flowState.definition !== source
    )
      return;
    const mapping = current.flowState.nodes?.find((node) => node.id === id);
    if (!mapping || current.id !== walkthrough?.id) return;
    const focus = { walkthroughId: current.id, node: mapping };
    if (currentFlowSource(current, focus)) selectCard(focus);
  }
  return (
    <div id="flow-panel" hidden={hidden}>
      <p>
        Authored code flow · not runtime execution. Select a node to highlight
        its code.
      </p>
      <p role={flow?.status === "stale" ? "status" : undefined}>
        {flow?.message ?? "No walkthrough selected."}
      </p>
      {!hidden && walkthrough && flow?.status === "current" && source && (
        <Diagram
          key={walkthrough.id + source + JSON.stringify(flow.nodes)}
          source={source}
          edges={walkthrough.flow?.edges.length ?? 0}
          nodes={flow.nodes ?? []}
          selectNode={selectNode}
        />
      )}
    </div>
  );
}
