import { useEffect, useId, useRef, useState } from "react";
import { FlowCodePreview } from "./flow-code-preview";
import { useFlowZoom } from "./flow-zoom";
import mermaid from "mermaid";
import type { Walkthrough } from "../types.mjs";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";
import {
  flowChangeLabels,
  type FlowChange,
  type FlowChanges,
} from "./flow-changes";

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

const flowChangeKinds: FlowChange[] = ["changed", "unchanged", "unknown"];
function colourNode(
  element: SVGElement,
  id: string,
  changes: FlowChanges | undefined
) {
  const kind = changes ? (changes[id] ?? "unknown") : undefined;
  if (kind) {
    element.setAttribute("data-flow-change", kind);
    element.setAttribute(
      "aria-description",
      flowChangeLabels[kind] +
        " in this file's Before/After pair; not a behavioral-change claim."
    );
  } else {
    element.removeAttribute("data-flow-change");
    element.removeAttribute("aria-description");
  }
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
  selected,
  previewNode,
  previewId,
  preview,
  leave,
  dismiss,
  popOut,
  popOutBusy,
  changes,
}: {
  changes?: FlowChanges;
  source: string;
  edges: number;
  nodes: NonNullable<Walkthrough["flowState"]["nodes"]>;
  selectNode: (id: string) => void;
  selected: FlowSourceFocus | null;
  previewNode?: string;
  previewId: string;
  preview: (
    id: string,
    element: SVGElement,
    keyboard: boolean,
    focus?: boolean
  ) => void;
  leave: (element: SVGElement) => void;
  dismiss: () => void;
  popOut?: () => void;
  popOutBusy?: boolean;
}) {
  const target = useRef<HTMLDivElement>(null);
  const colours = useRef(changes);
  colours.current = changes;
  useEffect(() => {
    for (const element of target.current?.querySelectorAll<SVGElement>(
      "[data-flow-node]"
    ) ?? [])
      colourNode(element, element.dataset.flowNode!, changes);
  }, [changes]);
  const action = useRef(selectNode);
  action.current = selectNode;
  const previewActions = useRef({ preview, leave, dismiss });
  previewActions.current = { preview, leave, dismiss };
  useEffect(() => {
    for (const element of target.current?.querySelectorAll<SVGElement>(
      "[data-flow-node]"
    ) ?? []) {
      if (element.dataset.flowNode === previewNode)
        element.setAttribute("aria-describedby", previewId + "-help");
      else element.removeAttribute("aria-describedby");
    }
  }, [previewNode, previewId]);
  const mappings = useRef(nodes);
  mappings.current = nodes;
  const selectedId = useRef(selected?.node.id);
  selectedId.current = selected?.node.id;
  useEffect(() => {
    for (const node of target.current?.querySelectorAll<SVGElement>(
      "[data-flow-node]"
    ) ?? [])
      node.setAttribute(
        "aria-pressed",
        String(node.dataset.flowNode === selected?.node.id)
      );
  }, [selected?.node.id]);
  const [status, setStatus] = useState("Rendering flow…");
  const zoom = useFlowZoom(target);
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
            element.setAttribute("aria-label", "Select node: " + mapping.label);
            element.setAttribute("data-flow-step", mapping.stepId);
            element.setAttribute("data-flow-node", mapping.id);
            colourNode(element, mapping.id, colours.current);
            element.setAttribute(
              "aria-pressed",
              String(mapping.id === selectedId.current)
            );
            element.addEventListener("click", () => {
              if (!cancelled) action.current(mapping.id);
            });
            element.addEventListener("pointerenter", () => {
              if (!cancelled)
                previewActions.current.preview(mapping.id, element, false);
            });
            element.addEventListener("pointerleave", (event) => {
              // React's portal enter runs before native SVG pointerleave.
              // Moving into the preview must not schedule a later close.
              if (
                !cancelled &&
                !(
                  event.relatedTarget instanceof Element &&
                  event.relatedTarget.closest(".flow-code-preview")
                )
              )
                previewActions.current.leave(element);
            });
            element.addEventListener("focus", () => {
              if (!cancelled)
                previewActions.current.preview(mapping.id, element, true);
            });
            element.addEventListener("blur", (event) => {
              if (
                !cancelled &&
                !(
                  event.relatedTarget instanceof Element &&
                  event.relatedTarget.closest(".flow-code-preview")
                )
              )
                previewActions.current.leave(element);
            });
            element.addEventListener("keydown", (event) => {
              if (
                !cancelled &&
                (event.key === "Escape" || event.key === "F2")
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") previewActions.current.dismiss();
                else
                  previewActions.current.preview(
                    mapping.id,
                    element,
                    true,
                    true
                  );
              }
              if (!cancelled && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                action.current(mapping.id);
              }
            });
          }
          target.current.replaceChildren(passive);
          zoom.install(passive);
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
      {changes && (
        <div
          className="flow-change-legend"
          role="group"
          aria-label="Flow change legend"
          aria-description="Changes in linked source lines for each file's Before/After pair; not behavioral changes."
        >
          {flowChangeKinds
            .filter(
              (kind) =>
                kind !== "unknown" || Object.values(changes).includes("unknown")
            )
            .map((kind) => (
              <span key={kind}>
                <i aria-hidden="true" data-flow-change={kind} />
                {flowChangeLabels[kind]}
              </span>
            ))}
        </div>
      )}
      <div className="flow-toolbar">
        {popOut && (
          <button type="button" disabled={popOutBusy} onClick={popOut}>
            Pop out Flow
          </button>
        )}
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!zoom.canOut}
          onClick={zoom.out}
        >
          −
        </button>
        <button
          type="button"
          className="flow-zoom-percent"
          aria-label="Reset zoom to 100%"
          aria-description={"Current zoom: " + zoom.percent}
          title="Reset zoom to 100%"
          disabled={!zoom.ready}
          onClick={zoom.reset}
        >
          {zoom.percent}
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={!zoom.canIn}
          onClick={zoom.in}
        >
          +
        </button>
        <button
          type="button"
          aria-pressed={zoom.fit}
          disabled={!zoom.ready}
          onClick={zoom.toggleFit}
        >
          {zoom.fit ? "Actual size" : "Fit diagram"}
        </button>
        <span
          className="flow-selected-label"
          aria-live="polite"
          title={selected?.node.label}
        >
          {selected?.node.label ?? "Select a node"}
        </span>
      </div>
      <div
        className={"walkthrough-flow" + (zoom.fit ? " fit" : "")}
        ref={target}
      />
    </>
  );
}

export function WalkthroughFlow({
  walkthrough,
  hidden,
  selectCard,
  popOut,
  popOutBusy,
  id = "flow-panel",
  previewSourceLabel,
  changes,
}: {
  changes?: FlowChanges;
  previewSourceLabel?: string;
  id?: string;
  walkthrough: Walkthrough | null;
  hidden: boolean;
  selectCard: (focus: FlowSourceFocus) => void;
  popOut?: () => void;
  popOutBusy?: boolean;
}) {
  const latest = useRef(walkthrough);
  latest.current = walkthrough;
  const flow = walkthrough?.flowState;
  const source = flow?.definition ?? "";
  const key = JSON.stringify([
    walkthrough?.id,
    hidden,
    flow?.status,
    source,
    flow?.nodes,
  ]);
  const scope = useRef({ key, lifetime: Symbol() });
  if (scope.current.key !== key) scope.current = { key, lifetime: Symbol() };
  const lifetime = scope.current.lifetime;
  const isHidden = useRef(hidden);
  isHidden.current = hidden;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previewId = useId();
  type Preview = {
    focus: FlowSourceFocus;
    anchor: SVGElement;
    lifetime: symbol;
  };
  const [peek, setPeek] = useState<Preview | null>(null);
  const peekRef = useRef<Preview | null>(null);
  const suppressFocus = useRef<SVGElement | null>(null);
  const jobs = useRef<{
    epoch: symbol;
    closing: symbol;
    open?: ReturnType<typeof setTimeout>;
    close?: ReturnType<typeof setTimeout>;
    frame?: number;
    pendingFocus?: SVGElement;
  }>({ epoch: Symbol(), closing: Symbol() });
  function cancelJobs() {
    clearTimeout(jobs.current.open);
    clearTimeout(jobs.current.close);
    if (jobs.current.frame !== undefined)
      cancelAnimationFrame(jobs.current.frame);
    jobs.current.pendingFocus = undefined;
    jobs.current.open = undefined;
    jobs.current.close = undefined;
    jobs.current.frame = undefined;
    jobs.current.epoch = Symbol();
    jobs.current.closing = Symbol();
  }
  function dismissPreview(returnFocus = false, expected = peekRef.current) {
    if (expected && peekRef.current !== expected) return;
    cancelJobs();
    peekRef.current = null;
    setPeek(null);
    if (
      returnFocus &&
      expected?.lifetime === scope.current.lifetime &&
      expected.anchor.isConnected &&
      !isHidden.current &&
      currentFlowSource(latest.current, expected.focus)
    ) {
      suppressFocus.current = expected.anchor;
      expected.anchor.focus({ preventScroll: true });
      suppressFocus.current = null;
    }
  }
  function leavePreview(element?: SVGElement) {
    const active = document.activeElement;
    if (
      element === active ||
      (!element &&
        (active === peekRef.current?.anchor ||
          active?.closest(".flow-code-preview")))
    )
      return;
    clearTimeout(jobs.current.open);
    clearTimeout(jobs.current.close);
    jobs.current.epoch = Symbol();
    const expected = peekRef.current,
      closing = Symbol();
    jobs.current.closing = closing;
    jobs.current.close = setTimeout(() => {
      if (
        jobs.current.closing === closing &&
        expected &&
        peekRef.current === expected
      )
        dismissPreview(false, expected);
    }, 180);
  }
  function beginPreview(
    id: string,
    anchor: SVGElement,
    keyboard: boolean,
    focusPopup = false
  ) {
    if (keyboard && suppressFocus.current === anchor) return;
    cancelJobs();
    if (peekRef.current?.anchor !== anchor) {
      peekRef.current = null;
      setPeek(null);
    }
    const epoch = jobs.current.epoch;
    const open = () => {
      const live = latest.current;
      if (
        jobs.current.epoch !== epoch ||
        !mounted.current ||
        isHidden.current ||
        scope.current.lifetime !== lifetime ||
        !anchor.isConnected ||
        anchor.closest("[hidden]") ||
        live?.id !== walkthrough?.id ||
        live?.flowState.definition !== source
      )
        return;
      const node = live.flowState.nodes?.find((n) => n.id === id);
      if (!node) return;
      const focus = { walkthroughId: live.id, node };
      if (!currentFlowSource(live, focus)) return;
      const next = { focus, anchor, lifetime };
      peekRef.current = next;
      setPeek(next);
      if (focusPopup)
        requestAnimationFrame(() => {
          if (
            peekRef.current === next &&
            mounted.current &&
            anchor.isConnected &&
            scope.current.lifetime === lifetime &&
            !isHidden.current &&
            currentFlowSource(latest.current, focus)
          ) {
            const root = document.getElementById(previewId);
            (
              root?.querySelector<HTMLElement>(".code") ??
              root?.querySelector<HTMLElement>("button")
            )?.focus({ preventScroll: true });
          }
        });
    };
    if (keyboard) {
      // Native focus may scroll the graph into view. Show after those scroll
      // events, rather than opening and immediately dismissing the preview.
      jobs.current.pendingFocus = anchor;
      jobs.current.frame = requestAnimationFrame(() => {
        if (jobs.current.epoch !== epoch) return;
        jobs.current.pendingFocus = undefined;
        open();
      });
    } else jobs.current.open = setTimeout(open, 160);
  }
  useEffect(() => {
    const scroll = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".flow-code-preview")
      )
        return;
      if (
        !peekRef.current &&
        jobs.current.pendingFocus === document.activeElement
      )
        return;
      dismissPreview();
    };
    const close = () => dismissPreview();
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        (peekRef.current ||
          jobs.current.open !== undefined ||
          jobs.current.pendingFocus)
      ) {
        event.preventDefault();
        dismissPreview();
      }
    };
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      cancelJobs();
      peekRef.current = null;
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [lifetime]);
  const visiblePeek =
    peek?.lifetime === lifetime &&
    !hidden &&
    currentFlowSource(walkthrough, peek.focus)
      ? peek
      : null;
  const [selection, setSelection] = useState<{
    focus: FlowSourceFocus;
    lifetime: symbol;
  } | null>(null);
  const selected =
    selection?.lifetime === lifetime &&
    currentFlowSource(walkthrough, selection.focus)
      ? selection.focus
      : null;
  function selectNode(id: string) {
    const current = latest.current;
    // Re-check latest post-poll state, not the card list captured before await.
    if (
      !mounted.current ||
      isHidden.current ||
      scope.current.lifetime !== lifetime ||
      !current ||
      current.flowState.status !== "current" ||
      current.flowState.definition !== source
    )
      return;
    const mapping = current.flowState.nodes?.find((node) => node.id === id);
    if (!mapping || current.id !== walkthrough?.id) return;
    const focus = { walkthroughId: current.id, node: mapping };
    if (currentFlowSource(current, focus)) {
      setSelection({ focus, lifetime });
      selectCard(focus);
    }
  }
  return (
    <div
      id={id}
      hidden={hidden}
      onKeyDown={(event) => {
        // Arrow keys in the diagram must not invoke the reader's global card navigation.
        if (event.key === "ArrowLeft" || event.key === "ArrowRight")
          event.stopPropagation();
      }}
    >
      {flow?.status !== "current" && (
        <p role={flow?.status === "stale" ? "status" : undefined}>
          {flow?.message ?? "No walkthrough selected."}
        </p>
      )}
      {!hidden && walkthrough && flow?.status === "current" && source && (
        <Diagram
          key={walkthrough.id + source + JSON.stringify(flow.nodes)}
          source={source}
          edges={walkthrough.flow?.edges.length ?? 0}
          nodes={flow.nodes ?? []}
          changes={changes}
          selectNode={selectNode}
          selected={selected}
          previewNode={visiblePeek?.focus.node.id}
          previewId={previewId}
          preview={beginPreview}
          leave={leavePreview}
          dismiss={() => dismissPreview()}
          popOut={popOut}
          popOutBusy={popOutBusy}
        />
      )}
      {visiblePeek && walkthrough && (
        <FlowCodePreview
          key={String(visiblePeek.focus.node.id)}
          walkthrough={walkthrough}
          sourceLabel={previewSourceLabel}
          focus={visiblePeek.focus}
          anchor={visiblePeek.anchor}
          id={previewId}
          enter={() => {
            if (peekRef.current === visiblePeek) {
              clearTimeout(jobs.current.close);
              jobs.current.closing = Symbol();
            }
          }}
          leave={() => {
            if (peekRef.current === visiblePeek) leavePreview();
          }}
          close={(returnFocus) => dismissPreview(returnFocus, visiblePeek)}
        />
      )}
    </div>
  );
}
