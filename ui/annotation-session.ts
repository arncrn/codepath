import { useRef, useState } from "react";
import type { SourceAttachment, SourceRef, Walkthrough } from "../types.mjs";
import { repairStepSource } from "./api";
import type { DialogRequest } from "./dialogs";

export function useAnnotationSession({
  walkthroughId,
  selectedStepId,
  selectStep,
  showVariables,
  beginDialogRequest,
  refresh,
  clearError,
  fail,
}: {
  walkthroughId?: string;
  selectedStepId: string | null;
  selectStep: (stepId: string, scroll?: boolean) => void;
  showVariables: () => void;
  beginDialogRequest: () => DialogRequest;
  refresh: () => Promise<void>;
  clearError: () => void;
  fail: (error: unknown) => void;
}) {
  const [ranges, setRanges] = useState<
    Partial<Record<string, SourceAttachment>>
  >({});
  const [revealed, setRevealed] = useState<{
    walkthroughId: string;
    stepId: string;
    ids: string[];
  } | null>(null);
  const view = useRef({ walkthroughId, selectedStepId });
  view.current = { walkthroughId, selectedStepId };
  function selectRange(stepId: string, range: SourceAttachment) {
    if (!walkthroughId) return;
    setRanges((current) => ({
      ...current,
      [JSON.stringify([walkthroughId, stepId])]: range,
    }));
  }
  function clearRange(stepId: string) {
    setRanges((current) => {
      const next = { ...current };
      delete next[JSON.stringify([walkthroughId, stepId])];
      return next;
    });
  }
  function reveal(stepId: string, ids: string[]) {
    if (!walkthroughId) return;
    if (selectedStepId !== stepId) selectStep(stepId, false);
    showVariables();
    setRevealed({ walkthroughId, stepId, ids });
    requestAnimationFrame(() => {
      if (
        view.current.walkthroughId !== walkthroughId ||
        view.current.selectedStepId !== stepId
      )
        return;
      const list = document.getElementById("variables");
      const entry = [
        ...(list?.querySelectorAll<HTMLElement>("[data-explanation-id]") ?? []),
      ].find((element) => ids.includes(element.dataset.explanationId ?? ""));
      if (list && entry) list.scrollTop = entry.offsetTop;
    });
  }
  async function repair(
    target: Walkthrough,
    stepId: string,
    source: SourceRef,
    fileHash: string
  ) {
    const request = beginDialogRequest();
    try {
      clearError();
      await repairStepSource({
        walkthroughId: target.id,
        stepId,
        expectedRevision: target.revision,
        source,
        fileHash,
      });
      if (!request.isCurrent()) return;
      request.close();
      await refresh();
    } catch (error) {
      if (request.isCurrent()) fail(error);
    }
  }
  return {
    selectRange,
    clearRange,
    reveal,
    repair,
    selectedRange: ranges[JSON.stringify([walkthroughId, selectedStepId])],
    revealedIds:
      revealed?.walkthroughId === walkthroughId &&
      revealed?.stepId === selectedStepId
        ? revealed.ids
        : [],
  };
}
