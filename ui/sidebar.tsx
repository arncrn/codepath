import type { Overview } from "../types.mjs";
import { SourceFiles } from "./source-files";

export function Sidebar({
  overview,
  walkthroughId,
  openWalkthrough,
  chooseSource,
  create,
  connectAgent,
  fail,
}: {
  overview: Overview | null;
  walkthroughId: string | undefined;
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
