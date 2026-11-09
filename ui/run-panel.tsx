import { useRef } from "react";
import type { Overview, Run, Step, ToolArgs } from "../types.mjs";
import { recordRun } from "./api";

export type RunSelection = { kind: "fixture" } | { kind: "saved"; run: Run };

const pretty = (value: unknown) =>
  value === undefined ? "Not captured" : JSON.stringify(value, null, 2);

export function RunPanel({
  walkthroughId,
  currentStep,
  overview,
  selection,
  selectRun,
  acceptImportedRun,
  refresh,
  hidden,
  fail,
}: {
  walkthroughId: string | undefined;
  currentStep: Step | undefined;
  overview: Overview | null;
  selection: RunSelection;
  selectRun: (id: string) => Promise<void>;
  acceptImportedRun: (run: Run) => void;
  refresh: () => Promise<void>;
  hidden: boolean;
  fail: (error: unknown) => void;
}) {
  const runFile = useRef<HTMLInputElement>(null);
  const run = selection.kind === "saved" ? selection.run : null;
  const runId = run?.id ?? "example";
  const events =
      run?.events.filter((event) => event.stepId === currentStep?.id) || [],
    data = runId === "example" ? currentStep?.sample : events.at(-1),
    recorded = runId !== "example" && run?.mode === "recorded";
  const sourceHash = data && "sourceHash" in data ? data.sourceHash : undefined;
  const mismatch = !!(
    recorded &&
    data &&
    sourceHash !== currentStep?.code?.fileHash
  );

  async function importRun(file: File | undefined) {
    try {
      if (!file || !walkthroughId) return;
      if (file.size > 1024 * 1024) throw Error("Run exceeds 1 MiB.");
      const input: Omit<ToolArgs["record_run"], "walkthroughId"> = JSON.parse(
        await file.text()
      );
      const result = await recordRun({
        ...input,
        walkthroughId,
      });
      acceptImportedRun(result);
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      if (runFile.current) runFile.current.value = "";
    }
  }
  return (
    <div id="data-panel" hidden={hidden}>
      <div className="data-controls">
        <div>
          <span
            id="data-badge"
            className={"badge " + (recorded ? "source" : "warning")}
          >
            {recorded ? "● Captured execution" : "◇ Illustrative data"}
          </span>
          <small id="data-context">
            {recorded
              ? "Selected checkpoints, not every executed line"
              : "Sample values · not executed"}
          </small>
        </div>
        <div>
          <select
            id="runs"
            aria-label="Captured run"
            value={runId}
            onChange={(event) => void selectRun(event.target.value).catch(fail)}
          >
            <option value="example">Example fixture</option>
            {overview?.runs
              .filter(
                (runSummary) => runSummary.walkthroughId === walkthroughId
              )
              .map((runSummary) => (
                <option key={runSummary.id} value={runSummary.id}>
                  {runSummary.mode === "recorded" ? "Recorded" : "Example"} ·{" "}
                  {runSummary.label} ·{" "}
                  {new Date(runSummary.at).toLocaleTimeString()}
                </option>
              ))}
          </select>
          <button id="import-run" onClick={() => runFile.current!.click()}>
            Import JSON
          </button>
          <input
            id="run-file"
            ref={runFile}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => void importRun(event.target.files?.[0])}
          />
        </div>
      </div>
      <p id="revision-warning" hidden={!mismatch}>
        {sourceHash
          ? "Source changed since this capture. Values belong to the recorded revision."
          : "This capture did not identify its source revision."}
      </p>
      <div id="values">
        {data ? (
          <div className="data-grid">
            <div>
              <h4>INPUT</h4>
              <pre>{pretty(data.input)}</pre>
            </div>
            <span>→</span>
            <div>
              <h4>OUTPUT</h4>
              <pre>{pretty(data.output)}</pre>
            </div>
          </div>
        ) : (
          <div className="empty">
            {runId === "example"
              ? "No sample values for this step. Ask your agent to attach a fixture or import an instrumented run."
              : "No event was captured at this step. That alone does not prove it was skipped."}
          </div>
        )}
      </div>
      <p id="origin">
        {(events.length > 1
          ? events.length + " events; showing the last. "
          : "") +
          (run?.origin ||
            "Run the example to capture real values. Illustrative fixtures are saved with the path.")}
      </p>
    </div>
  );
}
