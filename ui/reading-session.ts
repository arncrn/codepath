import { useEffect, useMemo, useRef, useState } from "react";
import type { Overview, Walkthrough } from "../types.mjs";
import { errorMessage } from "../types.mjs";
import { getProjectOverview, getWalkthrough } from "./api";
import {
  config,
  loadReadingContext,
  onRefresh,
  saveReadingContext,
} from "./transport";
import type { ReadingContext } from "./reading-context";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";
import { createRefreshQueue } from "./refresh-queue";

interface ReadingEffects {
  dialogOpen: boolean;
  resetDraft: () => void;
  switchDraftScope: (key: string | null) => void;
  clearSource: () => void;
  closeSourceMenu: () => void;
  scrollToStep: (id: string) => void;
  focusFlowSource: (focus: FlowSourceFocus) => void;
  clearFlowSource: () => void;
  fail: (error: unknown) => void;
}

export function useReadingSession(options: ReadingEffects) {
  const [contextReady, setContextReady] = useState(false);
  const restored = useRef<ReadingContext | null>(null),
    initialized = useRef(false),
    restorePending = useRef(true);
  const [overview, setOverview] = useState<Overview | null>(null),
    [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null),
    [selectedStepId, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<ReadingContext["tab"]>("notes");
  const view = useRef({ overview, walkthrough, selectedStepId });
  view.current = { overview, walkthrough, selectedStepId };
  const latestViewRequestNumber = useRef(0),
    workspaceSignature = useRef(""),
    consumedFocusNonce = useRef<string | null>(null),
    modalOpen = useRef(false),
    isViewMounted = useRef(true);
  const refreshQueue = useMemo(createRefreshQueue, []);
  const refreshAction = useRef<(force?: boolean) => Promise<void>>(
    async () => {}
  );
  const effects = useRef(options);
  effects.current = options;
  function acceptSavedWalkthrough(value: Walkthrough | null) {
    view.current.walkthrough = value;
    setWalkthrough(value);
  }
  function clearWalkthrough() {
    acceptSavedWalkthrough(null);
    setSelected(null);
    effects.current.clearSource();
    effects.current.switchDraftScope(null);
    effects.current.resetDraft();
  }
  function selectStep(id: string, scroll = true) {
    effects.current.clearFlowSource();
    effects.current.switchDraftScope(
      view.current.walkthrough
        ? JSON.stringify([view.current.walkthrough.id, id])
        : null
    );
    setSelected(id);
    effects.current.resetDraft();
    if (scroll) effects.current.scrollToStep(id);
  }
  async function openWalkthrough(
    walkthroughId: string,
    requestedStepId?: string,
    _workspaceOverview = view.current.overview,
    stillCurrent: () => boolean = () => true
  ) {
    if (requestedStepId || walkthroughId !== view.current.walkthrough?.id)
      effects.current.clearFlowSource();
    const thisLoadRequestNumber = ++latestViewRequestNumber.current;
    const previousWalkthrough = view.current.walkthrough;
    const current = () =>
      isViewMounted.current &&
      stillCurrent() &&
      thisLoadRequestNumber === latestViewRequestNumber.current;
    const loadedWalkthrough = await getWalkthrough(walkthroughId).catch(
      (error: unknown) => {
        if (current()) throw error;
        return null;
      }
    );
    if (!loadedWalkthrough || !current()) return;
    const isDifferentWalkthrough = previousWalkthrough?.id !== walkthroughId;
    acceptSavedWalkthrough(loadedWalkthrough);
    if (
      requestedStepId &&
      loadedWalkthrough.steps.some((step) => step.id === requestedStepId)
    )
      selectStep(requestedStepId);
    else if (
      isDifferentWalkthrough ||
      !loadedWalkthrough.steps.some(
        (step) => step.id === view.current.selectedStepId
      )
    ) {
      const first = loadedWalkthrough.steps[0]?.id ?? null;
      effects.current.switchDraftScope(
        first ? JSON.stringify([loadedWalkthrough.id, first]) : null
      );
      setSelected(first);
      effects.current.resetDraft();
    }
    effects.current.closeSourceMenu();
  }
  function refresh(force = false, current: () => boolean = () => true) {
    return refreshQueue(
      () => refreshRead(force, current),
      force,
      () => isViewMounted.current && current()
    );
  }
  async function refreshRead(force: boolean, current: () => boolean) {
    if (!initialized.current) {
      if (force) throw Error("Workspace is still opening. Try Refresh again.");
      return;
    }
    if (force) workspaceSignature.current = "";
    const viewRequestNumberAtRefreshStart = latestViewRequestNumber.current;
    try {
      const refreshedOverview = await getProjectOverview(
        view.current.walkthrough?.id
      );
      if (
        !isViewMounted.current ||
        !current() ||
        viewRequestNumberAtRefreshStart !== latestViewRequestNumber.current
      )
        return;
      const refreshedWorkspaceSignature =
        refreshedOverview.revision + ":" + refreshedOverview.index.version;
      const hasWorkspaceChanged =
        workspaceSignature.current !== refreshedWorkspaceSignature;
      view.current.overview = refreshedOverview;
      setOverview(refreshedOverview);
      workspaceSignature.current = refreshedWorkspaceSignature;
      if (
        view.current.walkthrough &&
        !refreshedOverview.paths.some(
          (path) => path.id === view.current.walkthrough!.id
        )
      )
        clearWalkthrough();
      const savedReadingContext = restorePending.current
        ? restored.current
        : null;
      restorePending.current = false;
      if (
        refreshedOverview.focus &&
        refreshedOverview.paths.some(
          (path) => path.id === refreshedOverview.focus!.walkthroughId
        ) &&
        refreshedOverview.focus.nonce !== consumedFocusNonce.current &&
        !modalOpen.current
      ) {
        consumedFocusNonce.current = refreshedOverview.focus.nonce;
        await openWalkthrough(
          refreshedOverview.focus.walkthroughId,
          refreshedOverview.focus.stepId,
          refreshedOverview,
          current
        );
      } else if (
        savedReadingContext &&
        refreshedOverview.paths.some(
          (path) => path.id === savedReadingContext.walkthroughId
        )
      ) {
        await openWalkthrough(
          savedReadingContext.walkthroughId!,
          savedReadingContext.stepId ?? undefined,
          refreshedOverview,
          current
        );
      } else if (!view.current.walkthrough && refreshedOverview.paths.length) {
        await openWalkthrough(
          refreshedOverview.paths.find(
            (path) => path.id === "checkout-" + config.backend
          )?.id || refreshedOverview.paths[0].id,
          undefined,
          refreshedOverview,
          current
        );
      } else if (hasWorkspaceChanged && view.current.walkthrough) {
        await openWalkthrough(
          view.current.walkthrough.id,
          undefined,
          refreshedOverview,
          current
        );
      }
    } catch (error) {
      if (!isViewMounted.current || !current()) return;
      if (errorMessage(error) === "Walkthrough not found.") {
        clearWalkthrough();
        workspaceSignature.current = "";
      } else if (force) throw error;
      else effects.current.fail(error);
    }
  }
  refreshAction.current = refresh;
  useEffect(() => {
    isViewMounted.current = true;
    void (async () => {
      const saved = await loadReadingContext();
      if (!isViewMounted.current) return;
      restored.current = saved;
      if (saved) {
        setTab(saved.tab);
        consumedFocusNonce.current = saved.focusNonce;
      }
      initialized.current = true;
      await refreshAction.current();
      if (isViewMounted.current) setContextReady(true);
    })();
    const timer = setInterval(() => void refreshAction.current(), 2000);
    const unsubscribe = onRefresh(() => {
      if (!initialized.current) return; // Initial load already reads the newest workspace.
      void refreshAction.current(true).catch((error: unknown) => {
        if (isViewMounted.current) effects.current.fail(error);
      });
    });
    return () => {
      isViewMounted.current = false;
      latestViewRequestNumber.current++;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!contextReady) return;
    void saveReadingContext({
      version: 1,
      walkthroughId: walkthrough?.id ?? null,
      stepId: selectedStepId,
      tab,
      focusNonce: consumedFocusNonce.current,
    });
  }, [contextReady, walkthrough, selectedStepId, tab]);
  useEffect(() => {
    modalOpen.current = options.dialogOpen;
  }, [options.dialogOpen]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        modalOpen.current ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          event.target instanceof Element ? event.target.tagName : ""
        ) ||
        event.defaultPrevented
      )
        return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const state = view.current,
          position =
            state.walkthrough?.steps.findIndex(
              (step) => step.id === state.selectedStepId
            ) ?? -1,
          target =
            state.walkthrough?.steps[
              position + (event.key === "ArrowRight" ? 1 : -1)
            ];
        if (target) selectStep(target.id);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  function acceptOverview(overview: Overview) {
    view.current.overview = overview;
    setOverview(overview);
  }
  function discardDeletedWalkthrough(id: string) {
    latestViewRequestNumber.current++;
    if (view.current.walkthrough?.id === id) clearWalkthrough();
    workspaceSignature.current = "";
  }
  const currentStep = walkthrough?.steps.find(
    (step) => step.id === selectedStepId
  );
  const position = currentStep ? walkthrough!.steps.indexOf(currentStep) : -1;
  function move(delta: -1 | 1) {
    const target = walkthrough?.steps[position + delta];
    if (target) selectStep(target.id);
  }
  return {
    overview,
    walkthrough,
    selectedStepId,
    currentStep,
    position,
    tab,
    currentWalkthrough: () => view.current.walkthrough,
    acceptSavedWalkthrough,
    acceptOverview,
    openWalkthrough,
    discardDeletedWalkthrough,
    selectStep,
    selectFlowCard: (focus: FlowSourceFocus) => {
      const walk = view.current.walkthrough;
      if (!walk || !currentFlowSource(walk, focus)) return;
      effects.current.switchDraftScope(
        JSON.stringify([walk.id, focus.node.stepId])
      );
      setSelected(focus.node.stepId);
      effects.current.focusFlowSource(focus);
    },
    selectAfterRemoval: (id: string | null) => {
      effects.current.switchDraftScope(
        id && view.current.walkthrough
          ? JSON.stringify([view.current.walkthrough.id, id])
          : null
      );
      effects.current.resetDraft();
      setSelected(id);
    },
    changeTab: (tab: ReadingContext["tab"]) => setTab(tab),
    move,
    refresh,
  };
}
