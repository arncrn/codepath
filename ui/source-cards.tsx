import { useEffect, useRef, useState } from "react";
import type { SourceAttachment, Walkthrough } from "../types.mjs";
import { CodeLines } from "./source-code";
import { FunctionContextLabel } from "./function-context";
import { blockLineLabel, wholeLineBlock } from "./block-notes";
import { CallbackRoleSummary } from "./callback-roles";
import type { SourceMenuPosition } from "./source-menu";
import { inVSCode } from "./transport";
import { followDefinition, openSourceInEditor } from "./api";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";

export function useSourceCards() {
  const rail = useRef<HTMLDivElement>(null);
  const [expandedStepIds, setExpandedStepIds] = useState(new Set<string>());
  const [menu, setMenu] = useState<SourceMenuPosition | null>(null);
  const [flowFocus, setFlowFocus] = useState<FlowSourceFocus | null>(null);
  const scrollRequest = useRef<symbol | null>(null);
  function clearFlowSource() {
    scrollRequest.current = Symbol();
    setFlowFocus(null);
  }
  function focusFlowSource(focus: FlowSourceFocus) {
    scrollRequest.current = Symbol();
    setFlowFocus(focus);
  }
  function closeMenu() {
    setMenu(null);
  }
  function reset() {
    clearFlowSource();
    setExpandedStepIds(new Set());
  }
  function scrollTo(id: string) {
    clearFlowSource();
    const request = scrollRequest.current;
    requestAnimationFrame(() => {
      if (
        request !== scrollRequest.current ||
        !rail.current ||
        rail.current.closest("[hidden]")
      )
        return;
      [...rail.current.querySelectorAll<HTMLElement>("[data-step]")]
        .find((element) => element.dataset.step === id)
        ?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
    });
  }
  function revealFlowSource(focus: FlowSourceFocus, admitted: () => boolean) {
    const request = scrollRequest.current;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled || request !== scrollRequest.current || !admitted()) return;
      const row = rail.current;
      if (!row || row.closest("[hidden]")) return;
      const card = row.querySelector<HTMLElement>(".code-card.active");
      const pane = card?.querySelector<HTMLElement>(".code");
      if (!card || card.dataset.step !== focus.node.stepId || !pane) return;
      // scrollIntoView walks every ancestor. Move only the two owned containers.
      function within(
        container: HTMLElement,
        target: { left: number; right: number; top: number; bottom: number },
        horizontalOnly = false
      ) {
        const rect = container.getBoundingClientRect();
        function delta(
          start: number,
          size: number,
          first: number,
          last: number
        ) {
          const gap = Math.min(12, size / 8),
            available = size - 2 * gap;
          if (last - first > available || first < start + gap)
            return first - start - gap;
          return last > start + size - gap ? last - start - size + gap : 0;
        }
        const dx = delta(
          rect.left + container.clientLeft,
          container.clientWidth,
          target.left,
          target.right
        );
        const dy = horizontalOnly
          ? 0
          : delta(
              rect.top + container.clientTop,
              container.clientHeight,
              target.top,
              target.bottom
            );
        if (dx || dy)
          container.scrollTo({
            left: container.scrollLeft + dx,
            top: container.scrollTop + dy,
            behavior: "instant",
          });
      }
      within(row, card.getBoundingClientRect(), true);
      const marks = [
        ...pane.querySelectorAll<HTMLElement>("[data-flow-source]"),
      ];
      if (!marks.length) return;
      const bounds = marks.map((mark) => mark.getBoundingClientRect());
      within(pane, {
        left: Math.min(...bounds.map((r) => r.left)),
        right: Math.max(...bounds.map((r) => r.right)),
        top: Math.min(...bounds.map((r) => r.top)),
        bottom: Math.max(...bounds.map((r) => r.bottom)),
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }
  function toggleFull(id: string) {
    setExpandedStepIds((expanded) => {
      const updated = new Set(expanded);
      if (updated.has(id)) updated.delete(id);
      else updated.add(id);
      return updated;
    });
  }
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("#source-menu")
      )
        closeMenu();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const scroll = () => closeMenu();
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    return () => {
      scrollRequest.current = null;
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", scroll, true);
    };
  }, []);
  return {
    rail,
    flowFocus,
    focusFlowSource,
    revealFlowSource,
    clearFlowSource,
    expandedStepIds,
    menu,
    openMenu: setMenu,
    closeMenu,
    reset,
    scrollTo,
    toggleFull,
  };
}

export function SourceCards({
  active,
  walkthrough,
  selectedStepId,
  display,
  selectStep,
  showNotes,
  revealExplanations,
  selectRange,
  selectedRange,
  createBlockNote,
  repairSource,
  removeStep,
  moveStep,
  start,
  connectAgent,
  fail,
}: {
  active: boolean;
  walkthrough: Walkthrough | null;
  selectedStepId: string | null;
  display: ReturnType<typeof useSourceCards>;
  selectStep: (id: string, scroll?: boolean) => void;
  showNotes: () => void;
  revealExplanations: (stepId: string, ids: string[]) => void;
  selectRange: (stepId: string, range: SourceAttachment) => void;
  selectedRange?: SourceAttachment;
  createBlockNote: (stepId: string, range: SourceAttachment) => void;
  repairSource: (stepId: string) => void;
  removeStep: (id: string) => Promise<void>;
  moveStep: (id: string, delta: -1 | 1) => Promise<void>;
  start: () => void;
  connectAgent: () => void;
  fail: (error: unknown) => void;
}) {
  const focus = display.flowFocus;
  const validFocus =
    active &&
    focus?.node.stepId === selectedStepId &&
    currentFlowSource(walkthrough, focus);
  const latest = useRef({ active, walkthrough, focus, selectedStepId });
  latest.current = { active, walkthrough, focus, selectedStepId };
  useEffect(() => {
    if (focus && !validFocus) display.clearFlowSource();
    if (!focus || !validFocus) return;
    return display.revealFlowSource(focus, () => {
      const current = latest.current;
      return (
        current.active &&
        current.focus === focus &&
        current.selectedStepId === focus.node.stepId &&
        currentFlowSource(current.walkthrough, focus)
      );
    });
  }, [focus, validFocus]);
  return (
    <>
      <div className="caption">
        <span id="source-help">
          {inVSCode
            ? "Right-click a source identifier → Follow definition"
            : "Live source · selected function or range highlighted"}
        </span>
        <span>← → to follow the path</span>
      </div>
      <div id="rail" className="rail" ref={display.rail}>
        {walkthrough?.steps.length ? (
          walkthrough.steps.map((step, position) => {
            const block =
              step.id === selectedStepId && selectedRange
                ? wholeLineBlock(step, selectedRange)
                : null;
            return (
              <article
                key={step.id}
                className={
                  "code-card " + (step.id === selectedStepId ? "active" : "")
                }
                data-step={step.id}
                onContextMenu={(event) => {
                  const token = (
                    event.target instanceof Element
                      ? event.target
                      : event.currentTarget
                  ).closest<HTMLElement>(".source-token");
                  if (!inVSCode || !token) return;
                  event.preventDefault();
                  if (selectedStepId !== step.id) selectStep(step.id, false);
                  const rect = token.getBoundingClientRect();
                  display.openMenu({
                    reference: JSON.parse(token.dataset.reference!),
                    name: token.dataset.sourceName!,
                    x: event.clientX || rect.left,
                    y: event.clientY || rect.bottom,
                  });
                }}
                onKeyDown={(event) => {
                  const token = (
                    event.target instanceof Element
                      ? event.target
                      : event.currentTarget
                  ).closest<HTMLElement>(".source-token");
                  if (!inVSCode || !token || event.key !== "Enter") return;
                  event.preventDefault();
                  void followDefinition(
                    JSON.parse(token.dataset.reference!)
                  ).catch(fail);
                }}
                onClick={async (event) => {
                  if (selectedStepId !== step.id) selectStep(step.id, false);
                  const element =
                      event.target instanceof Element
                        ? event.target
                        : event.currentTarget,
                    token = element.closest<HTMLElement>(".source-token"),
                    action =
                      element.closest<HTMLElement>("[data-action]")?.dataset
                        .action;
                  try {
                    if (inVSCode && token && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      await followDefinition(
                        JSON.parse(token.dataset.reference!)
                      );
                      return;
                    }
                    if (action === "open-source")
                      await openSourceInEditor({
                        walkthroughId: walkthrough!.id,
                        stepId: step.id,
                      });
                    else if (action === "full") display.toggleFull(step.id);
                    else if (action === "notes") showNotes();
                    else if (action === "remove") await removeStep(step.id);
                    else if (action === "left" || action === "right")
                      await moveStep(step.id, action === "left" ? -1 : 1);
                  } catch (error) {
                    fail(error);
                  }
                }}
              >
                <div className="card-title">
                  <span>{String(position + 1).padStart(2, "0")}</span>
                  <h3>{step.title}</h3>
                  {step.stale && (
                    <span className="badge warning">
                      {step.error
                        ? "Source unavailable"
                        : step.snapshotHash !== step.code?.hash
                          ? "Source changed"
                          : "Explanation needs review"}
                    </span>
                  )}
                </div>
                <div className="filename">
                  {step.source.file}
                  <small>
                    {/\.go$/.test(step.source.file)
                      ? "GO"
                      : /\.[cm]?tsx?$/.test(step.source.file)
                        ? "TS"
                        : "JS"}
                  </small>
                </div>
                <div className="symbol">
                  <span>
                    {step.source.symbol ||
                      "lines " +
                        (step.code?.startLine ?? step.source.startLine) +
                        "–" +
                        (step.code?.endLine ?? step.source.endLine)}
                  </span>
                  {inVSCode && (
                    <button data-action="open-source">Open in editor ↗</button>
                  )}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      repairSource(step.id);
                    }}
                  >
                    Repair source reference
                  </button>
                  <button data-action="full">
                    {display.expandedStepIds.has(step.id)
                      ? "Focus range"
                      : "Full file"}
                  </button>
                </div>
                <div className="code">
                  <FunctionContextLabel step={step} />
                  <CodeLines
                    step={step}
                    walkthroughId={walkthrough!.id}
                    full={display.expandedStepIds.has(step.id)}
                    flowSource={
                      validFocus && focus?.node.stepId === step.id
                        ? focus.node.attachment
                        : undefined
                    }
                    selectRange={(range) => {
                      display.clearFlowSource();
                      if (selectedStepId !== step.id)
                        selectStep(step.id, false);
                      selectRange(step.id, range);
                    }}
                    reveal={(ids) => revealExplanations(step.id, ids)}
                  />
                </div>
                {block && (
                  <div className="block-selection-actions">
                    <span>{blockLineLabel([block])}</span>
                    <button
                      type="button"
                      className="secondary"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        createBlockNote(step.id, block);
                        window.getSelection()?.removeAllRanges();
                      }}
                    >
                      Create note
                    </button>
                  </div>
                )}
                <div className="reason">
                  {position > 0 && step.evidence === "inferred" && (
                    <span
                      className="badge warning"
                      title="The connection to the previous step has not been confirmed."
                    >
                      Connection not verified
                    </span>
                  )}
                  <CallbackRoleSummary role={step.callbackRole} />
                  <p>{step.explanation || "No code explanation yet."}</p>
                </div>
                <footer>
                  <button data-action="notes">
                    ▤{" "}
                    {
                      step.notes.filter(
                        (note) => !note.archived && !note.variableName
                      ).length
                    }{" "}
                    notes
                  </button>
                  <span className="reorder">
                    <button data-action="left" aria-label="Move step left">
                      ←
                    </button>
                    <button data-action="right" aria-label="Move step right">
                      →
                    </button>
                    <button data-action="remove" aria-label="Remove step">
                      ×
                    </button>
                  </span>
                </footer>
              </article>
            );
          })
        ) : (
          <div className="welcome">
            <div className="welcome-mark">↳</div>
            <h2>
              {walkthrough
                ? "Where does this behavior begin?"
                : "Your source is ready."}
            </h2>
            <p>
              Pick a button, function, API handler or test.
              <br />
              Every next step stays beside the last one.
            </p>
            <button
              className="primary"
              id="welcome-start"
              onClick={() => start()}
            >
              {walkthrough ? "Choose the first step" : "Create a walkthrough"}
            </button>
            <button id="welcome-agent" onClick={() => connectAgent()}>
              Or ask your agent to map it →
            </button>
          </div>
        )}
      </div>
    </>
  );
}
