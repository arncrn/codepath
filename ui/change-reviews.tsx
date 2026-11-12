import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ComparisonNotes,
  ComparisonWalkthrough,
  ComparisonWalkthroughStep,
} from "../types.mjs";
import { errorMessage } from "../types.mjs";
import { getComparisonWalkthrough } from "./api";
import { ComparisonAnnotations } from "./comparison-annotations";
import type {
  ComparisonAnnotationContext,
  ComparisonDraft,
  ComparisonDrafts,
} from "./comparison-annotations";
import { diffRows, excerptRows, rawLineNumbers } from "./git-diff-rows";
import { tokenizeSource } from "./source-syntax";

// One owner for saved loading, annotation-only polling and in-memory drafts.
// Guide actions deliberately know nothing about current query/file/progress.
export function useChangeReview(active: boolean) {
  const [id, setId] = useState<string | null>(null);
  const [walkthrough, setWalkthrough] = useState<ComparisonWalkthrough | null>(
    null
  );
  const current = useRef(walkthrough);
  const [stepId, setStepId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = useRef(Symbol("guide"));
  const presentation = useRef(Symbol("guide presentation"));
  const [savedOpen, setSavedOpen] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [drafts, setDrafts] = useState<ComparisonDrafts>({});
  const draftRef = useRef(drafts);
  function display(value: ComparisonWalkthrough | null) {
    current.current = value;
    setWalkthrough(value);
  }
  function select(next: string | null, step: string | null = null) {
    request.current = Symbol("guide selection");
    presentation.current = Symbol("guide presentation");
    setSavedOpen(false);
    display(null);
    setError("");
    setStepId(step);
    setId(next);
    setLoadVersion((version) => version + 1);
  }
  function editDraft(key: string, draft: ComparisonDraft | undefined) {
    const next = { ...draftRef.current };
    if (draft) next[key] = draft;
    else delete next[key];
    draftRef.current = next;
    setDrafts(next);
  }
  function clearSubmittedDraft(key: string, submitted: ComparisonDraft) {
    const next = draftRef.current[key];
    if (
      next?.instance === submitted.instance &&
      next.version === submitted.version
    )
      editDraft(key, undefined);
  }
  useEffect(() => {
    const token = Symbol("guide load");
    request.current = token;
    if (active && id)
      void getComparisonWalkthrough(id)
        .then((result) => {
          if (request.current === token) display(result);
        })
        .catch((error: unknown) => {
          if (request.current === token) setError(errorMessage(error));
        });
    return () => {
      request.current = Symbol("retired guide");
    };
  }, [active, id, loadVersion]);
  function saved(
    original: ComparisonWalkthroughStep,
    annotations: ComparisonNotes
  ) {
    const walk = current.current;
    if (!walk) return;
    const step = walk.steps.find(
      (step) =>
        step.id === original.id &&
        step.fileId === original.fileId &&
        step.annotations.scope === original.annotations.scope &&
        step.binding === original.binding
    );
    if (step && annotations.revision > step.annotations.revision)
      display({
        ...walk,
        steps: walk.steps.map((s) => (s === step ? { ...s, annotations } : s)),
      });
  }
  useEffect(() => {
    if (!active || !id) return;
    const token = request.current;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void getComparisonWalkthrough(id)
        .then((result) => {
          if (token !== request.current || current.current?.id !== id) return;
          for (const step of result.steps) saved(step, step.annotations);
        })
        .catch((error: unknown) => {
          if (token === request.current) setError(errorMessage(error));
        })
        .finally(() => {
          pending = false;
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [active, id, loadVersion]);
  function annotation(
    view: ComparisonWalkthroughStep,
    side: "before" | "after",
    sourceCurrent: () => boolean
  ): ComparisonAnnotationContext {
    const token = request.current,
      ui = presentation.current;
    return {
      view,
      side,
      walkthroughId: id!,
      authored: view[side],
      drafts,
      editDraft,
      clearSubmittedDraft,
      lifetime: ui,
      current: () =>
        request.current === token &&
        presentation.current === ui &&
        current.current?.id === id &&
        sourceCurrent(),
      saved: (original, annotations) => {
        if (request.current === token && current.current?.id === id)
          saved(original, annotations);
      },
    };
  }
  function retire() {
    presentation.current = Symbol("retired guide presentation");
  }
  function chooseStep(next: string) {
    retire();
    setStepId(next);
  }
  function expandSaved(open: boolean) {
    retire();
    setSavedOpen(open);
  }
  return {
    id,
    select,
    walkthrough,
    error,
    stepId,
    chooseStep,
    annotation,
    savedOpen,
    expandSaved,
    retire,
  };
}
export type ChangeReview = ReturnType<typeof useChangeReview>;

// Historical inspection is explicit and independent of current inventory success.
// It never replaces current source or participates in Viewed progress.
export function SavedVersions({ guide }: { guide: ChangeReview }) {
  const walk = guide.walkthrough;
  const step =
    walk?.steps.find((step) => step.id === guide.stepId) ?? walk?.steps[0];
  return (
    <details
      open={guide.savedOpen}
      onToggle={(event) => {
        if (event.currentTarget.open !== guide.savedOpen)
          guide.expandSaved(event.currentTarget.open);
      }}
    >
      <summary>Read saved versions (not current changes)</summary>
      {guide.savedOpen && walk && step && (
        <>
          <p>
            Historical authored source only. Inspecting it does not mark current
            changes Viewed.
          </p>
          <nav className="comparison-steps" aria-label="Saved version steps">
            {walk.steps.map((s) => (
              <button
                key={s.id}
                aria-label={s.title}
                aria-current={step.id === s.id ? "step" : undefined}
                onClick={() => guide.chooseStep(s.id)}
              >
                {s.title} · {s.id}
              </button>
            ))}
          </nav>
          <SavedStep
            key={walk.id + step.id + step.binding}
            guide={guide}
            step={step}
          />
        </>
      )}
    </details>
  );
}
export function GuideDisplay({
  guide,
  steps = guide.walkthrough?.steps ?? [],
  step: selectedStep,
  chooseStep = (step) => guide.chooseStep(step.id),
  children,
}: {
  guide: ChangeReview;
  steps?: readonly ComparisonWalkthroughStep[];
  step?: ComparisonWalkthroughStep;
  chooseStep?: (step: ComparisonWalkthroughStep) => void;
  children?: ReactNode;
}) {
  const walk = guide.walkthrough;
  const step =
    selectedStep ?? steps.find((step) => step.id === guide.stepId) ?? steps[0];
  return (
    <section id="git-comparisons" className="guide-display">
      {guide.error && <p role="alert">{guide.error}</p>}
      <h2>{walk?.title ?? "Opening guide…"}</h2>
      {walk && step && (
        <>
          <nav
            className="comparison-steps"
            aria-label="Paired walkthrough steps"
          >
            {steps.map((item) => (
              <button
                key={item.id}
                aria-label={item.title}
                aria-current={item.id === step.id ? "step" : undefined}
                onClick={() => {
                  if (item.id !== step.id) chooseStep(item);
                }}
              >
                {item.title}
              </button>
            ))}
          </nav>
          {children ?? (
            <SavedStep
              key={walk.id + step.id + step.binding}
              guide={guide}
              step={step}
              historical={false}
            />
          )}
        </>
      )}
      {!walk && children}
    </section>
  );
}

function SavedStep({
  guide,
  step,
  historical = true,
}: {
  guide: ChangeReview;
  step: ComparisonWalkthroughStep;
  historical?: boolean;
}) {
  const prepared = useMemo(() => {
    const diff = diffRows(step);
    return {
      rows: diff ? excerptRows(diff, step.before, step.after) : null,
      syntax: {
        before: tokenizeSource(step.before.file, step.before.code.lines),
        after: tokenizeSource(step.after.file, step.after.code.lines),
      },
    };
  }, [step.before, step.after]);
  return (
    <div className="comparison-scroll saved-versions">
      <div
        className="walkthrough-columns"
        style={{ gridTemplateRows: "auto auto auto" }}
      >
        {(["before", "after"] as const).map((side) => (
          <section
            key={side}
            className="comparison-column"
            data-comparison-column={side}
          >
            <h2>
              {side === "before" ? "Before" : "After"}
              {historical && (
                <small>Saved versions · not current changes</small>
              )}
            </h2>
            <article className="authored-card" data-paired-step={step.id}>
              <ComparisonAnnotations
                {...guide.annotation(step, side, () => true)}
                surface="saved"
                changedLines={
                  (side === "before"
                    ? prepared.rows?.removed
                    : prepared.rows?.added) ?? new Set()
                }
                rowLines={
                  prepared.rows?.[side] ??
                  rawLineNumbers(step[side].content ?? "").filter(
                    (line) =>
                      line >= step[side].startLine && line <= step[side].endLine
                  )
                }
                plainDiff={!prepared.rows}
                syntax={prepared.syntax[side]}
              />
            </article>
          </section>
        ))}
      </div>
    </div>
  );
}
