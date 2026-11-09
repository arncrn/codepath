import { useEffect, useState } from "react";
import { errorMessage } from "../types.mjs";
import { useAnnotationSession } from "./annotation-session";
import { useAnnotationEditor } from "./annotation-editor";
import { NotesPanel, useNoteDraft } from "./notes";
import { Dialogs, useDialogs } from "./dialogs";
import { RunPanel } from "./run-panel";
import { SourceCards, useSourceCards } from "./source-cards";
import { SourceMenu } from "./source-menu";
import { createWalkthroughCommands } from "./walkthrough-commands";
import { useReadingSession } from "./reading-session";
import { Sidebar } from "./sidebar";
import { DetailPanels, PathHeader, WorkspaceHeader } from "./workspace-layout";

export function App() {
  const [error, setError] = useState("");
  const fail = (error: unknown) => setError(errorMessage(error));
  const dialogs = useDialogs();
  const draft = useNoteDraft(fail);
  const sourceDisplay = useSourceCards();
  const reader = useReadingSession({
    dialogOpen: !!dialogs.modal,
    resetDraft: draft.reset,
    clearSource: sourceDisplay.reset,
    closeSourceMenu: sourceDisplay.closeMenu,
    scrollToStep: sourceDisplay.scrollTo,
    fail,
  });
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
  function chooseSource(file?: string) {
    dialogs.open(
      reader.walkthrough ? { kind: "picker", file } : { kind: "create" }
    );
  }
  return (
    <>
      <Sidebar
        overview={reader.overview}
        walkthroughId={reader.walkthrough?.id}
        openWalkthrough={reader.openWalkthrough}
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
          refresh={() => void reader.refresh(true)}
        />
        <PathHeader
          overview={reader.overview}
          walkthrough={reader.walkthrough}
          selectedStepId={reader.selectedStepId}
          selectStep={reader.selectStep}
          openWalkthrough={reader.openWalkthrough}
          openDemo={() => dialogs.open({ kind: "demo" })}
          addStep={() => chooseSource()}
          deletePath={() => void commands.openDelete()}
          fail={fail}
        />
        <SourceCards
          walkthrough={reader.walkthrough}
          selectedStepId={reader.selectedStepId}
          display={sourceDisplay}
          selectStep={reader.selectStep}
          showNotes={() => reader.changeTab("notes")}
          selectRange={annotations.selectRange}
          selectedRange={annotations.selectedRange}
          createBlockNote={(stepId, range) => {
            const walkthrough = reader.walkthrough;
            const step = walkthrough?.steps.find((step) => step.id === stepId);
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
          <RunPanel
            walkthroughId={reader.walkthrough?.id}
            currentStep={reader.currentStep}
            overview={reader.overview}
            selection={reader.runSelection}
            selectRun={reader.selectRun}
            acceptImportedRun={reader.acceptImportedRun}
            refresh={reader.refresh}
            hidden={reader.tab !== "data"}
            fail={fail}
          />
          <NotesPanel
            currentStep={reader.currentStep}
            tab={reader.tab}
            draft={draft}
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
