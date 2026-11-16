import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ComparisonNotes,
  ComparisonWalkthrough,
  ComparisonWalkthroughStep,
} from "../types.mjs";
import { errorMessage } from "../types.mjs";
import { getComparisonWalkthrough } from "./api";
import type {
  ComparisonAnnotationContext,
  ComparisonDraft,
  ComparisonDrafts,
} from "./comparison-annotations";

// One owner for guide loading, annotation-only polling and in-memory drafts.
// Visibility is independent of permission to attach/edit against current code.
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
  return {
    id,
    select,
    walkthrough,
    error,
    stepId,
    chooseStep,
    annotation,
    drafts,
    retire,
  };
}
export type ChangeReview = ReturnType<typeof useChangeReview>;

export function GuideDisplay({
  guide,
  id = "git-comparisons",
  steps = guide.walkthrough?.steps ?? [],
  step: selectedStep,
  chooseStep = (step) => guide.chooseStep(step.id),
  children,
}: {
  guide: ChangeReview;
  id?: string;
  steps?: readonly ComparisonWalkthroughStep[];
  step?: ComparisonWalkthroughStep;
  chooseStep?: (step: ComparisonWalkthroughStep) => void;
  children?: ReactNode;
}) {
  const walk = guide.walkthrough,
    step =
      selectedStep ??
      steps.find((step) => step.id === guide.stepId) ??
      steps[0];
  return (
    <section id={id} className="guide-display">
      <h2>{walk?.title ?? "Opening guide…"}</h2>
      {walk && step && steps.length > 1 && (
        <label className="comparison-explanation-choice">
          Comparison explanation to edit
          <select
            aria-label="Comparison explanation to edit"
            value={step.id}
            onChange={(event) => {
              const item = steps.find((item) => item.id === event.target.value);
              if (item && item.id !== step.id) chooseStep(item);
            }}
          >
            {steps.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {children}
    </section>
  );
}
