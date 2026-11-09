import { Fragment } from "react";
import type { ReactNode } from "react";
import type { Overview, Step, Walkthrough } from "../types.mjs";
import type { ReadingContext } from "./reading-context";
import { config } from "./transport";

export function WorkspaceHeader({
  overview,
  error,
  dismissError,
  refresh,
}: {
  overview: Overview | null;
  error: string;
  dismissError: () => void;
  refresh: () => void;
}) {
  return (
    <>
      <header className="topbar">
        <span id="breadcrumb">
          {overview ? overview.project + " / Walkthrough" : "Local workspace"}
        </span>
        <div>
          <span className="prototype">Prototype 0.7</span>
          <button
            id="refresh"
            onClick={() => {
              refresh();
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </header>
      <div
        id="error"
        role="alert"
        hidden={!error}
        onClick={() => dismissError()}
      >
        {error && error + " · Click to dismiss"}
      </div>
      <div id="warnings">
        {overview?.index.warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </div>
    </>
  );
}

export function PathHeader({
  overview,
  walkthrough,
  selectedStepId,
  selectStep,
  openWalkthrough,
  openDemo,
  addStep,
  deletePath,
  fail,
}: {
  overview: Overview | null;
  walkthrough: Walkthrough | null;
  selectedStepId: string | null;
  selectStep: (id: string) => void;
  openWalkthrough: (id: string) => Promise<void>;
  openDemo: () => void;
  addStep: () => void;
  deletePath: () => void;
  fail: (error: unknown) => void;
}) {
  return (
    <>
      <section className="path-header">
        <div>
          <h1 id="title">{walkthrough?.title || "Follow one behavior."}</h1>
        </div>
        <div className="actions">
          <button
            id="demo"
            className="primary"
            hidden={
              !config.demo ||
              !overview?.paths.some(
                (path) => path.id === "checkout-" + config.backend
              )
            }
            onClick={() =>
              void openWalkthrough("checkout-" + config.backend)
                .then(() => openDemo())
                .catch(fail)
            }
          >
            ▷ Try the example
          </button>
          <button
            id="add"
            className="secondary"
            disabled={!walkthrough}
            onClick={() => addStep()}
          >
            ＋ Add step
          </button>
          <button
            id="delete-path"
            className="secondary danger"
            hidden={!walkthrough}
            onClick={() => deletePath()}
          >
            Delete walkthrough
          </button>
        </div>
      </section>
      <div id="steps" className="steps" aria-label="Path steps">
        {walkthrough?.steps.map((step, position) => (
          <Fragment key={step.id}>
            <button
              data-select={step.id}
              className={step.id === selectedStepId ? "active" : ""}
              onClick={() => selectStep(step.id)}
            >
              <span>{position + 1}</span>
              {step.title}
            </button>
            {position < walkthrough.steps.length - 1 && <b>→</b>}
          </Fragment>
        ))}
      </div>
    </>
  );
}

export function DetailPanels({
  currentStep,
  position,
  stepCount,
  hasWalkthrough,
  tab,
  changeTab,
  navigate,
  children,
}: {
  currentStep: Step | undefined;
  position: number;
  stepCount: number;
  hasWalkthrough: boolean;
  tab: ReadingContext["tab"];
  changeTab: (tab: ReadingContext["tab"]) => void;
  navigate: (delta: -1 | 1) => void;
  children: ReactNode;
}) {
  return (
    <section id="detail" hidden={!currentStep}>
      <div className="detail-heading">
        <div>
          <button
            id="data-tab"
            className={tab === "data" ? "active" : ""}
            onClick={() => changeTab("data")}
          >
            Data at this step
          </button>
          <button
            id="notes-tab"
            className={tab === "notes" ? "active" : ""}
            onClick={() => changeTab("notes")}
          >
            Notes ·{" "}
            {currentStep?.notes.filter(
              (note) => !note.archived && !note.variableName
            ).length ?? 0}
          </button>
          <button
            id="variables-tab"
            className={tab === "variables" ? "active" : ""}
            onClick={() => changeTab("variables")}
          >
            Variables ·{" "}
            {currentStep?.notes.filter(
              (note) => !note.archived && note.variableName
            ).length ?? 0}
          </button>
        </div>
        <div>
          <span id="position">
            {currentStep ? position + 1 + " / " + stepCount : ""}
          </span>
          <button
            id="prev"
            aria-label="Previous step"
            disabled={position <= 0}
            onClick={() => navigate(-1)}
          >
            ←
          </button>
          <button
            id="next"
            aria-label="Next step"
            disabled={!hasWalkthrough || position === stepCount - 1}
            onClick={() => navigate(1)}
          >
            →
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}
