import { useEffect, useMemo, useRef, useState } from "react";
import type { ComparisonWalkthroughSummary } from "../types.mjs";
import { listComparisonWalkthroughs } from "./api";
import { useChangeReview } from "./change-reviews";
import { CurrentChanges } from "./current-changes";
import { errorMessage } from "../types.mjs";
import { useAnnotationSession } from "./annotation-session";
import { useAnnotationEditor } from "./annotation-editor";
import { NotesPanel, useNoteDraft } from "./notes";
import { Dialogs, useDialogs } from "./dialogs";
import { WalkthroughFlow } from "./walkthrough-flow";
import { useFlowWindow } from "./flow-window";
import type { ReviewFlowRequest } from "./review-flow";
import type { ReviewFlowDisplay } from "./review-flow-presentation";
import { SourceCards, useSourceCards } from "./source-cards";
import { WalkthroughOverview, WalkthroughPages } from "./walkthrough-overview";
import { SourceMenu } from "./source-menu";
import { createWalkthroughCommands } from "./walkthrough-commands";
import { useReadingSession } from "./reading-session";
import { useManualRefresh, type RefreshTarget } from "./manual-refresh";
import { Sidebar, ComparisonChoices } from "./sidebar";
import { DetailPanels, PathHeader, WorkspaceHeader } from "./workspace-layout";

export function App() {
  const [error, setError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(() =>
    ["changes", "current-changes"].includes(
      new URLSearchParams(globalThis.location.search).get("view") ?? ""
    )
  );
  const initialGuide = useRef(
    new URLSearchParams(globalThis.location.search).get("view") === "changes"
  );
  const [focused, setFocused] = useState(false);
  const [reviewNavigationHidden, setReviewNavigationHidden] = useState(false);
  const guide = useChangeReview(reviewOpen);
  const [comparisons, setComparisons] = useState<
    ComparisonWalkthroughSummary[]
  >([]);
  const fail = (error: unknown) => setError(errorMessage(error));
  const dialogs = useDialogs();
  const draft = useNoteDraft(fail);
  const sourceDisplay = useSourceCards();
  const reader = useReadingSession({
    dialogOpen: !!dialogs.modal || reviewOpen,
    resetDraft: draft.reset,
    switchDraftScope: draft.switchScope,
    clearSource: sourceDisplay.reset,
    closeSourceMenu: sourceDisplay.closeMenu,
    scrollToStep: sourceDisplay.scrollTo,
    focusFlowSource: sourceDisplay.focusFlowSource,
    clearFlowSource: sourceDisplay.clearFlowSource,
    fail,
  });
  const [reviewRefreshTarget, setReviewRefreshTarget] =
    useState<RefreshTarget | null>(null);
  const refreshReader = useRef(reader.refresh);
  refreshReader.current = reader.refresh;
  const refreshTarget = useMemo<RefreshTarget>(
    () => ({
      current: () => !reviewOpen || !!reviewRefreshTarget?.current(),
      run: async (current) => {
        await Promise.all([
          refreshReader.current(true, current),
          reviewOpen ? reviewRefreshTarget?.run(current) : undefined,
        ]);
      },
    }),
    [reviewOpen, reader.walkthrough?.id, guide.id, reviewRefreshTarget]
  );
  const manualRefresh = useManualRefresh(refreshTarget);
  const [reviewFlowRequest, setReviewFlowRequest] =
    useState<ReviewFlowRequest | null>(null);
  const [reviewFlowDisplay, setReviewFlowDisplay] =
    useState<ReviewFlowDisplay | null>(null);
  const flowWindow = useFlowWindow(
    reviewOpen ? (reviewFlowDisplay?.walkthrough ?? null) : reader.walkthrough,
    !dialogs.modal &&
      (reviewOpen ? !!reviewFlowDisplay?.walkthrough : reader.page === "cards"),
    (focus) =>
      reviewOpen
        ? setReviewFlowRequest({
            focus,
            token: Symbol("detached review Flow"),
            contextKey: reviewFlowDisplay?.key,
          })
        : reader.selectFlowCard(focus),
    fail,
    reviewOpen ? "review" : "walkthrough",
    reviewOpen ? (reviewFlowDisplay?.key ?? "pending-review") : null,
    reviewOpen && reviewFlowDisplay?.mode === "after"
      ? {
          side: "after",
          label: reviewFlowDisplay.label,
          changes: reviewFlowDisplay.changes,
          message:
            reviewFlowDisplay.message.length <= 1900
              ? reviewFlowDisplay.message
              : "After Flow is unavailable. See the original reader for details.",
        }
      : undefined
  );
  useEffect(() => {
    let cancelled = false;
    void listComparisonWalkthroughs()
      .then((result) => {
        if (cancelled) return;
        setComparisons(result);
        if (initialGuide.current && result.length) {
          initialGuide.current = false;
          guide.select(result[0].id);
          setFocused(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) fail(error);
      });
    return () => {
      cancelled = true;
    };
  }, [reader.overview?.revision]);
  const annotations = useAnnotationSession({
    walkthroughId: reader.walkthrough?.id,
    selectedStepId: reader.selectedStepId,
    selectStep: reader.selectStep,
    showVariables: () => reader.changeTab("variables"),
    beginDialogRequest: dialogs.beginRequest,
    refresh: reader.refresh,
    clearError: () => setError(""),
    fail,
  });
  const noteEditor = useAnnotationEditor({
    step: reader.currentStep,
    walkthroughId: reader.walkthrough?.id,
    revision: reader.walkthrough?.revision,
    selectedRange: annotations.selectedRange,
    refresh: reader.refresh,
    fail,
    clearError: () => setError(""),
  });
  useEffect(() => {
    dialogs.invalidatePendingRequests();
  }, [dialogs.invalidatePendingRequests, reader.walkthrough?.id]);
  const commands = createWalkthroughCommands({
    reader,
    openDialog: dialogs.open,
    beginDialogRequest: dialogs.beginRequest,
    closeDialog: dialogs.close,
    clearError: () => setError(""),
    fail,
  });
  function changeFocus(checked: boolean) {
    initialGuide.current = false;
    setFocused(checked);
  }
  function openComparison(id: string, step?: string) {
    initialGuide.current = false;
    if (reviewOpen && guide.id === id && step === undefined) {
      setFocused((value) => !value);
      return;
    }
    guide.retire();
    setFocused(true);
    guide.select(id, step);
    setReviewOpen(true);
  }
  function chooseSource(file?: string) {
    dialogs.open(
      reader.walkthrough ? { kind: "picker", file } : { kind: "create" }
    );
  }
  return (
    <>
      <Sidebar
        hidden={reviewOpen && reviewNavigationHidden}
        overview={reader.overview}
        walkthroughId={reviewOpen ? undefined : reader.walkthrough?.id}
        comparisons={reviewOpen ? [] : comparisons}
        comparisonId={reviewOpen && focused ? guide.id : null}
        openComparison={openComparison}
        openWalkthrough={(id) => {
          initialGuide.current = false;
          guide.retire();
          setReviewOpen(false);
          return reader.openWalkthrough(id);
        }}
        chooseSource={chooseSource}
        create={() => dialogs.open({ kind: "create" })}
        connectAgent={() => dialogs.open({ kind: "agent" })}
        fail={fail}
      />
      <main id="workspace">
        <WorkspaceHeader
          overview={reader.overview}
          error={error}
          dismissError={() => setError("")}
          refresh={() => void manualRefresh.refresh()}
          refreshBusy={manualRefresh.busy}
          refreshMessage={manualRefresh.message}
          refreshFailed={manualRefresh.failed}
        />
        <div className="review-entry">
          <button
            onClick={() => {
              initialGuide.current = false;
              guide.retire();
              if (!reviewOpen) guide.select(null);
              setReviewOpen((value) => !value);
            }}
          >
            {reviewOpen ? "Back to walkthrough" : "Review changes"}
          </button>
          {reviewOpen && (
            <button
              type="button"
              className="secondary"
              aria-expanded={!reviewNavigationHidden}
              aria-controls="project-navigation comparison-navigation"
              onClick={() => setReviewNavigationHidden((value) => !value)}
            >
              {reviewNavigationHidden ? "Show navigation" : "Hide navigation"}
            </button>
          )}
        </div>
        <CurrentChanges
          active={reviewOpen}
          navigationHidden={reviewNavigationHidden}
          guide={guide}
          walkthrough={guide.id ? null : reader.walkthrough}
          flowWalkthrough={reader.walkthrough}
          walkthroughStepId={guide.id ? null : reader.selectedStepId}
          focused={focused}
          flowRequest={reviewFlowRequest}
          flowBlocked={!!dialogs.modal}
          popOutFlow={flowWindow.open}
          flowPopOutBusy={flowWindow.busy}
          onFlowDisplay={setReviewFlowDisplay}
          onRefreshTarget={setReviewRefreshTarget}
          manualRefresh={() => void manualRefresh.refresh()}
          refreshBusy={manualRefresh.busy}
          openGuide={openComparison}
          guideChoices={
            reviewOpen && (
              <ComparisonChoices
                comparisons={comparisons}
                comparisonId={guide.id}
                openComparison={openComparison}
                display={{ checked: focused, change: changeFocus }}
              />
            )
          }
        />
        <div className="walkthrough-surface" hidden={reviewOpen}>
          <PathHeader
            overview={reader.overview}
            walkthrough={reader.walkthrough}
            selectedStepId={reader.selectedStepId}
            selectStep={reader.selectStep}
            openWalkthrough={reader.openWalkthrough}
            openDemo={() => dialogs.open({ kind: "demo" })}
            addStep={() => chooseSource()}
            deletePath={() => void commands.openDelete()}
            pages={
              reader.walkthrough && (
                <WalkthroughPages
                  page={reader.page}
                  change={reader.changePage}
                />
              )
            }
            showSteps={reader.page === "cards"}
            fail={fail}
          />
          <WalkthroughOverview
            walkthrough={reader.walkthrough}
            hidden={reader.page !== "overview"}
            selectStep={reader.selectStep}
            readCards={() => reader.changePage("cards")}
            refresh={() => reader.refresh(true)}
          />
          <div id="walkthrough-cards" hidden={reader.page !== "cards"}>
            <SourceCards
              active={!reviewOpen && reader.page === "cards"}
              walkthrough={reader.walkthrough}
              selectedStepId={reader.selectedStepId}
              display={sourceDisplay}
              selectStep={reader.selectStep}
              showNotes={() => reader.changeTab("notes")}
              selectRange={annotations.selectRange}
              selectedRange={annotations.selectedRange}
              createBlockNote={(stepId, range) => {
                const walkthrough = reader.walkthrough;
                const step = walkthrough?.steps.find(
                  (step) => step.id === stepId
                );
                if (
                  walkthrough &&
                  step &&
                  noteEditor.createBlock(
                    {
                      step,
                      walkthroughId: walkthrough.id,
                      revision: walkthrough.revision,
                    },
                    range
                  )
                ) {
                  if (reader.selectedStepId !== stepId)
                    reader.selectStep(stepId, false);
                  reader.changeTab("notes");
                  annotations.clearRange(stepId);
                }
              }}
              revealExplanations={annotations.reveal}
              repairSource={(stepId) => {
                setError("");
                if (reader.walkthrough)
                  dialogs.open({
                    kind: "repair",
                    target: reader.walkthrough,
                    stepId,
                  });
              }}
              removeStep={commands.removeStep}
              moveStep={commands.moveStep}
              start={() => chooseSource()}
              connectAgent={() => dialogs.open({ kind: "agent" })}
              fail={fail}
            />
            <DetailPanels
              currentStep={reader.currentStep}
              position={reader.position}
              stepCount={reader.walkthrough?.steps.length ?? 0}
              hasWalkthrough={!!reader.walkthrough}
              tab={reader.tab}
              changeTab={reader.changeTab}
              navigate={reader.move}
            >
              <WalkthroughFlow
                walkthrough={reader.walkthrough}
                hidden={
                  reviewOpen ||
                  reader.page !== "cards" ||
                  !!dialogs.modal ||
                  reader.tab !== "flow"
                }
                selectCard={reader.selectFlowCard}
                popOut={flowWindow.open}
                popOutBusy={flowWindow.busy}
              />
              <NotesPanel
                currentStep={reader.currentStep}
                tab={reader.tab}
                draft={draft}
                revision={reader.walkthrough?.revision}
                review={noteEditor}
                revealedIds={annotations.revealedIds}
                target={
                  reader.walkthrough && reader.selectedStepId
                    ? {
                        walkthroughId: reader.walkthrough.id,
                        stepId: reader.selectedStepId,
                      }
                    : null
                }
                refresh={reader.refresh}
              />
            </DetailPanels>
          </div>
        </div>
        <footer className="workspace-footer">
          <span>LOCAL WORKSPACE</span>
          <span>Paths and notes saved in .codepaths/</span>
          <span>No hosted model</span>
        </footer>
      </main>
      <Dialogs
        modal={dialogs.modal}
        close={dialogs.close}
        error={error}
        overview={reader.overview}
        create={commands.create}
        addSource={commands.addSource}
        repairSource={annotations.repair}
        removePath={commands.removePath}
        openDelete={commands.openDelete}
        saveCallbackRole={commands.saveCallbackRole}
        openCallbackRole={commands.openCallbackRole}
        refresh={reader.refresh}
        fail={fail}
      />
      {sourceDisplay.menu && (
        <SourceMenu
          menu={sourceDisplay.menu}
          close={sourceDisplay.closeMenu}
          fail={fail}
        />
      )}
    </>
  );
}
