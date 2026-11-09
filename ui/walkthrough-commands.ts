import type {
  CallbackRole,
  Overview,
  SourceRef,
  StepInput,
  Walkthrough,
} from "../types.mjs";
import {
  deleteWalkthrough,
  getProjectOverview,
  getWalkthrough,
  listRuns,
  saveWalkthrough,
} from "./api";
import type { DialogRequest, Modal } from "./dialogs";

export interface WalkthroughCommandReader {
  currentWalkthrough(): Walkthrough | null;
  acceptSavedWalkthrough(walkthrough: Walkthrough): void;
  acceptOverview(overview: Overview): void;
  openWalkthrough(
    id: string,
    stepId?: string,
    overview?: Overview
  ): Promise<void>;
  discardDeletedWalkthrough(id: string): void;
  selectStep(id: string, scroll?: boolean): void;
  selectAfterRemoval(id: string | null): void;
  refresh(): Promise<void>;
}

export function createWalkthroughCommands({
  reader,
  openDialog,
  beginDialogRequest,
  closeDialog,
  clearError,
  fail,
}: {
  reader: WalkthroughCommandReader;
  openDialog: (modal: Modal) => void;
  beginDialogRequest: () => DialogRequest;
  closeDialog: () => void;
  clearError: () => void;
  fail: (error: unknown) => void;
}) {
  async function saveSteps(steps: StepInput[]) {
    const walkthrough = reader.currentWalkthrough();
    if (!walkthrough) return;
    const saved = await saveWalkthrough({
      id: walkthrough.id,
      title: walkthrough.title,
      description: walkthrough.description,
      steps,
      expectedRevision: walkthrough.revision,
    });
    reader.acceptSavedWalkthrough(saved);
    await reader.refresh();
  }
  async function addSource(source: SourceRef, title: string) {
    try {
      const walkthrough = reader.currentWalkthrough();
      if (!walkthrough) return;
      const id = crypto.randomUUID();
      await saveSteps([
        ...walkthrough.steps,
        { id, title, source, evidence: "inferred", explanation: "" },
      ]);
      closeDialog();
      reader.selectStep(id);
    } catch (error) {
      fail(error);
    }
  }
  async function create(title: string, description: string) {
    try {
      const saved = await saveWalkthrough({ title, description, steps: [] });
      const overview = await getProjectOverview();
      reader.acceptOverview(overview);
      await reader.openWalkthrough(saved.id, undefined, overview);
      openDialog({ kind: "picker" });
    } catch (error) {
      fail(error);
    }
  }
  async function openDelete(id = reader.currentWalkthrough()?.id) {
    if (!id) return;
    try {
      const target = await getWalkthrough(id);
      const runs = await listRuns(id);
      clearError();
      openDialog({ kind: "delete", target, runs: runs.length });
    } catch (error) {
      fail(error);
    }
  }
  async function removePath(target: Walkthrough) {
    try {
      await deleteWalkthrough({
        id: target.id,
        expectedRevision: target.revision,
      });
      reader.discardDeletedWalkthrough(target.id);
      clearError();
      closeDialog();
      await reader.refresh();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }
  async function openCallbackRole(
    stepId: string,
    id = reader.currentWalkthrough()?.id
  ) {
    if (!id) return;
    const request = beginDialogRequest();
    try {
      const target = await getWalkthrough(id);
      if (!request.isCurrent() || reader.currentWalkthrough()?.id !== target.id)
        return;
      const step = target.steps.find((step) => step.id === stepId);
      if (!step) throw Error("Step no longer exists. Refresh the path.");
      clearError();
      request.open({ kind: "callback-role", target, step });
    } catch (error) {
      if (request.isCurrent() && reader.currentWalkthrough()?.id === id)
        fail(error);
    }
  }
  async function saveCallbackRole(
    target: Walkthrough,
    stepId: string,
    role: CallbackRole | null
  ) {
    const request = beginDialogRequest();
    try {
      const saved = await saveWalkthrough({
        id: target.id,
        title: target.title,
        description: target.description,
        steps: target.steps.map((step) =>
          step.id === stepId ? { ...step, callbackRole: role } : step
        ),
        expectedRevision: target.revision,
      });
      const current = reader.currentWalkthrough();
      if (current?.id === saved.id && current.revision <= saved.revision)
        reader.acceptSavedWalkthrough(saved);
      await reader.refresh();
      return true;
    } catch (error) {
      if (request.isCurrent()) fail(error);
      return false;
    }
  }
  async function removeStep(id: string) {
    const walkthrough = reader.currentWalkthrough();
    if (!walkthrough) return;
    const position = walkthrough.steps.findIndex((step) => step.id === id);
    const steps = walkthrough.steps.filter((step) => step.id !== id);
    reader.selectAfterRemoval(steps[Math.max(0, position - 1)]?.id ?? null);
    await saveSteps(steps);
  }
  async function moveStep(id: string, delta: -1 | 1) {
    const walkthrough = reader.currentWalkthrough();
    if (!walkthrough) return;
    const steps = [...walkthrough.steps];
    const position = steps.findIndex((step) => step.id === id);
    const destination = position + delta;
    if (steps[destination]) {
      [steps[position], steps[destination]] = [
        steps[destination],
        steps[position],
      ];
      await saveSteps(steps);
      reader.selectStep(id);
    }
  }
  return {
    addSource,
    create,
    openDelete,
    removePath,
    removeStep,
    moveStep,
    openCallbackRole,
    saveCallbackRole,
  };
}
