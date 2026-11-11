import { useEffect, useRef, useState } from "react";
import type { SourceAttachment, Walkthrough } from "../types.mjs";
import { CodeLines } from "./source-code";
import { FunctionContextLabel } from "./function-context";
import { blockLineLabel, wholeLineBlock } from "./block-notes";
import { CallbackRoleSummary } from "./callback-roles";
import type { SourceMenuPosition } from "./source-menu";
import { inVSCode } from "./transport";
import { followDefinition, openSourceInEditor } from "./api";

export function useSourceCards() {
  const rail = useRef<HTMLDivElement>(null);
  const [expandedStepIds, setExpandedStepIds] = useState(new Set<string>());
  const [menu, setMenu] = useState<SourceMenuPosition | null>(null);
  function closeMenu() {
    setMenu(null);
  }
  function reset() {
    setExpandedStepIds(new Set());
  }
  function scrollTo(id: string) {
    requestAnimationFrame(() => {
      [...rail.current!.querySelectorAll<HTMLElement>("[data-step]")]
        .find((element) => element.dataset.step === id)
        ?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
    });
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
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", scroll, true);
    };
  }, []);
  return {
    rail,
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
                    selectRange={(range) => {
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
