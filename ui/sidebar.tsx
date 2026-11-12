import type { Overview, ComparisonWalkthroughSummary } from "../types.mjs";
import { SourceFiles } from "./source-files";

export function ComparisonChoices({
  comparisons,
  comparisonId,
  openComparison,
  display,
}: {
  comparisons: ComparisonWalkthroughSummary[];
  comparisonId?: string | null;
  openComparison?: (id: string) => void;
  display?: { checked: boolean; change: (checked: boolean) => void };
}) {
  return (
    <>
      {display && (
        <label className="focus-toggle">
          <input
            type="checkbox"
            aria-label="Show only changed sections"
            checked={display.checked}
            onChange={(event) => display.change(event.target.checked)}
            data-comparison-path={
              comparisons.length === 1 ? comparisons[0].id : undefined
            }
            className={display.checked ? "selected" : ""}
          />
          Show only changed sections
        </label>
      )}
      {(!display || comparisons.length > 1) &&
        comparisons.map((walk) => (
          <button
            key={walk.id}
            data-comparison-path={walk.id}
            className={
              walk.id === comparisonId && (!display || display.checked)
                ? "selected"
                : ""
            }
            onClick={() => openComparison?.(walk.id)}
          >
            {walk.title}
          </button>
        ))}
    </>
  );
}

export function Sidebar({
  overview,
  walkthroughId,
  comparisons = [],
  comparisonId,
  openComparison,
  openWalkthrough,
  chooseSource,
  create,
  connectAgent,
  fail,
}: {
  overview: Overview | null;
  walkthroughId: string | undefined;
  comparisons?: ComparisonWalkthroughSummary[];
  comparisonId?: string | null;
  openComparison?: (id: string) => void;
  openWalkthrough: (id: string) => Promise<void>;
  chooseSource: (file: string) => void;
  create: () => void;
  connectAgent: () => void;
  fail: (error: unknown) => void;
}) {
  return (
    <aside>
      <div className="brand">
        <span>↳</span>
        <div>
          codepath<small>LOCAL PROTOTYPE</small>
        </div>
      </div>
      <div id="project" className="project">
        {overview ? (
          <>
            <span className="dot" />
            <div>
              <strong>{overview.project}</strong>
              <small>
                {overview.index.fileCount ?? overview.index.files.length} source
                files
                {overview.index.discoveryComplete === false
                  ? " discovered"
                  : ""}{" "}
                · local folder
              </small>
            </div>
          </>
        ) : (
          "Opening source…"
        )}
      </div>
      <div className="section-label">WALKTHROUGHS</div>
      <nav id="paths">
        {overview?.paths.map((pathSummary) => (
          <button
            key={pathSummary.id}
            data-path={pathSummary.id}
            className={pathSummary.id === walkthroughId ? "selected" : ""}
            onClick={() => void openWalkthrough(pathSummary.id).catch(fail)}
          >
            ↳{" "}
            <span>
              {pathSummary.title}
              <small>{pathSummary.count} steps</small>
            </span>
          </button>
        ))}
        <ComparisonChoices
          comparisons={comparisons}
          comparisonId={comparisonId}
          openComparison={openComparison}
        />
      </nav>
      <button id="new-path" className="new-path" onClick={() => create()}>
        ＋ New walkthrough
      </button>
      <div className="section-label">PROJECT SOURCE</div>
      {overview && (
        <SourceFiles
          key={overview.root}
          initial={overview.index}
          chooseSource={chooseSource}
          fail={fail}
        />
      )}
      <footer>
        <button id="agent" onClick={() => connectAgent()}>
          Connect your agent ↗
        </button>
        <small>Local files · no account required</small>
      </footer>
    </aside>
  );
}
