import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  GitChangedFile,
  GitChangesPage,
  GitQuery,
  GitViewedPair,
  ToolResults,
  Step,
} from "../types.mjs";
import { errorMessage } from "../types.mjs";
import {
  listGitBranches,
  listGitChanges,
  getGitFile,
  getGitViewed,
  setGitViewed,
  clearGitViewed,
  checkGitComparison,
  listGitExplanations,
} from "./api";
import { diffRows, focusedRows, rawLineNumbers } from "./git-diff-rows";
import { CodeLines } from "./source-code";
import { FunctionContextLabel } from "./function-context";
import type { ChangeReview } from "./change-reviews";
import { GuideDisplay } from "./change-reviews";
import { useComparisonAnnotations } from "./comparison-annotations";
import type { ComparisonAnnotationContext } from "./comparison-annotations";

function sameQuery(a: GitQuery, b: GitQuery) {
  return a.mode === "changes"
    ? b.mode === "changes"
    : b.mode === "compare" && a.base === b.base && a.target === b.target;
}

type Inventory = GitChangesPage & { pairs: readonly GitViewedPair[] };
type FileView = ToolResults["get_git_file"];
export function CurrentChanges({
  active,
  guide,
  guideChoices,
  focused,
  openGuide,
}: {
  active: boolean;
  guide: ChangeReview;
  guideChoices?: ReactNode;
  focused: boolean;
  openGuide: (id: string, step?: string) => void;
}) {
  const [query, setQuery] = useState<GitQuery>({ mode: "changes" });
  const [branches, setBranches] = useState<ToolResults["list_git_branches"]>({
    branches: [],
  });
  const [scan, setScan] = useState<Inventory | null>(null);
  const scanRef = useRef(scan);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<FileView | null>(null);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [links, setLinks] = useState<ToolResults["list_git_explanations"]>([]);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(Symbol("inventory"));
  const fileRequest = useRef(Symbol("file"));
  const viewOwner = useRef<symbol | null>(null);
  const explanationRequest = useRef(Symbol("explanation lookup"));
  const actions = useRef(
    new Map<string, { instance: symbol; version: number }>()
  );
  const [busy, setBusy] = useState<Set<string>>(new Set());
  function display(value: Inventory | null) {
    scanRef.current = value;
    setScan(value);
  }
  useEffect(() => {
    const instance = Symbol("inventory");
    epoch.current = instance;
    actions.current.clear();
    setBusy(new Set());
    if (!active) return;
    setError("");
    setFileError("");
    setLoading(true);
    setView(null);
    display(null);
    void (async () => {
      const refs = await listGitBranches();
      if (epoch.current !== instance) return;
      setBranches(refs);
      let page = await listGitChanges({ query });
      const files = [...page.files],
        cursors = new Set<string>();
      while (epoch.current === instance) {
        display({ ...page, files: [...files], pairs: [] });
        // A later page may still contain the selected file. Do not replace it
        // until enumeration establishes that it is absent.
        setSelected((old) =>
          old && (!page.complete || files.some((file) => file.id === old))
            ? old
            : (files[0]?.id ?? null)
        );
        if (page.complete) break;
        if (!page.nextCursor || cursors.has(page.nextCursor))
          throw Error(
            "Inventory continuation unavailable; coverage is incomplete."
          );
        cursors.add(page.nextCursor);
        page = await listGitChanges({ query, cursor: page.nextCursor });
        if (epoch.current !== instance) return;
        files.push(...page.files);
      }
      if (epoch.current !== instance) return;
      const progress = await getGitViewed(page.listId);
      if (epoch.current !== instance) return;
      display({ ...page, files, pairs: progress.pairs });
      setSelected((old) =>
        files.some((file) => file.id === old) ? old : (files[0]?.id ?? null)
      );
      setLoading(false);
    })().catch((e: unknown) => {
      if (epoch.current === instance) {
        setError(errorMessage(e) + " Coverage is incomplete/unknown.");
        setLoading(false);
      }
    });
    return () => {
      epoch.current = Symbol("retired inventory");
      fileRequest.current = Symbol("retired file");
      actions.current.clear();
    };
  }, [active, query, refresh]);
  const selectedListed =
    scan?.files.some((file) => file.id === selected) ?? false;
  useEffect(() => {
    const token = Symbol("file");
    fileRequest.current = token;
    if (!active || !scan || !selected || !selectedListed) return;
    setFileError("");
    setView(null);
    setLinks([]);
    void getGitFile({ listId: scan.listId, fileId: selected })
      .then((next) => {
        if (fileRequest.current !== token) return;
        viewOwner.current = token;
        setView(next);
      })
      .catch((e: unknown) => {
        if (fileRequest.current === token) setFileError(errorMessage(e));
      });
    return () => {
      fileRequest.current = Symbol("retired file");
    };
  }, [active, scan?.listId, selected, selectedListed]);
  useEffect(() => {
    const source = fileRequest.current;
    const lookup = Symbol("explanation lookup");
    explanationRequest.current = lookup;
    setLinks([]);
    if (active && view && viewOwner.current === source) {
      void listGitExplanations({
        query,
        fileId: view.file.id,
        binding: view.binding,
      })
        .then((result) => {
          if (
            explanationRequest.current === lookup &&
            fileRequest.current === source
          ) {
            setLinks(result);
          }
        })
        .catch(() => {
          /* Optional explanations never block complete diff reading. */
        });
    }
    return () => {
      explanationRequest.current = Symbol("retired explanation lookup");
    };
  }, [active, view, query, guide.id]);
  useEffect(() => {
    if (!active || !scan?.complete || loading) return;
    const instance = epoch.current;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void checkGitComparison(scan.listId)
        .then((result) => {
          if (epoch.current !== instance) return;
          if (!result.current) {
            actions.current.clear();
            epoch.current = Symbol("changed sources");
            fileRequest.current = Symbol("changed sources");
            setView(null);
            setLinks([]);
            setRefresh((n) => n + 1);
          } else
            return getGitViewed(scan.listId).then((projection) => {
              const current = scanRef.current;
              if (epoch.current !== instance || current?.listId !== scan.listId)
                return;
              display({
                ...current,
                pairs: projection.pairs.map((pair) => {
                  const old = current.pairs.find(
                    (p) => p.fileId === pair.fileId
                  );
                  return pair.identity &&
                    old?.identity === pair.identity &&
                    (old.revision ?? -1) > (pair.revision ?? -1)
                    ? old
                    : pair;
                }),
              });
            });
        })
        .catch((e: unknown) => {
          if (epoch.current === instance)
            setError(errorMessage(e) + " Coverage is unknown; refresh.");
        })
        .finally(() => {
          pending = false;
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [active, scan?.listId, scan?.complete, loading]);
  function openFile(fileId: string) {
    if (guide.savedOpen) guide.expandSaved(false);
    if (selected === fileId) return;
    guide.retire();
    fileRequest.current = Symbol("file navigation");
    setView(null);
    setLinks([]);
    setSelected(fileId);
  }
  function choose(value: GitQuery) {
    epoch.current = Symbol("comparison choices changed");
    fileRequest.current = Symbol("retired file");
    actions.current.clear();
    setView(null);
    setLinks([]);
    setQuery(value);
  }
  function mark(file: GitChangedFile, pair: GitViewedPair) {
    if (!pair.identity) return;
    const owner = epoch.current,
      identity = pair.identity;
    const action = {
      instance: Symbol("Viewed action"),
      version: (actions.current.get(file.id)?.version ?? 0) + 1,
    };
    actions.current.set(file.id, action);
    setBusy((old) => new Set(old).add(file.id));
    const operation = pair.viewed
      ? clearGitViewed({ identity, expectedRevision: pair.revision })
      : setGitViewed({
          query,
          fileId: file.id,
          identity,
          expectedRevision: pair.revision,
        });
    void operation
      .then((ack) => {
        const current = scanRef.current,
          owned = actions.current.get(file.id);
        if (
          epoch.current !== owner ||
          owned?.instance !== action.instance ||
          owned.version !== action.version ||
          !current
        )
          return;
        display({
          ...current,
          pairs: current.pairs.map((p) =>
            p.fileId === file.id &&
            p.identity === identity &&
            p.revision <= ack.revision
              ? { fileId: file.id, ...ack }
              : p
          ),
        });
      })
      .catch((e: unknown) => {
        if (
          epoch.current === owner &&
          actions.current.get(file.id)?.instance === action.instance
        )
          setError(errorMessage(e));
      })
      .finally(() => {
        if (
          epoch.current !== owner ||
          actions.current.get(file.id)?.instance !== action.instance
        )
          return;
        setBusy((old) => {
          const next = new Set(old);
          next.delete(file.id);
          return next;
        });
      });
  }
  const sourceCurrent = () =>
    active && viewOwner.current === fileRequest.current;
  const currentView =
    sourceCurrent() && view?.file.id === selected ? view : null;
  const walk = guide.walkthrough;
  const guideSteps =
    walk?.steps.filter((step) => !selected || step.fileId === selected) ?? [];
  const guideStep =
    guideSteps.find((step) => step.id === guide.stepId) ?? guideSteps[0];
  // Explanations authorize their own exact source range, never the diff's extent.
  const matching =
    currentView && walk && sameQuery(query, walk.query)
      ? guideSteps.filter(
          (step) =>
            step.fileId === currentView.file.id &&
            step.binding === currentView.binding &&
            links.some(
              (link) =>
                link.walkthroughId === walk.id && link.stepId === step.id
            )
        )
      : [];
  const matched = guideSteps.some((step) => step.id === guide.stepId)
    ? matching.find((step) => step.id === guide.stepId)
    : matching[0];
  const guideStatus = guide.error
    ? "Could not load the guide."
    : !walk
      ? "Opening guide…"
      : !sameQuery(query, walk.query)
        ? "Saved guide uses different comparison choices."
        : matched
          ? "Explanations for these exact source versions."
          : "";
  return (
    <section
      id="current-changes"
      hidden={!active}
      aria-busy={loading}
      data-inventory-ready={
        scan?.complete && !loading && !error ? "true" : "false"
      }
    >
      <header className="comparison-heading">
        <div>
          <small>GIT REVIEW</small>
          <h1>Current changes</h1>
          {guide.id && guideStatus && (
            <p className="current-guide-status" role="status">
              {guideStatus}
            </p>
          )}
        </div>
        <button
          onClick={() => {
            epoch.current = Symbol("refresh");
            fileRequest.current = Symbol("refresh source");
            setView(null);
            setLinks([]);
            actions.current.clear();
            setRefresh((n) => n + 1);
          }}
        >
          Refresh changes
        </button>
      </header>
      <div className="current-source-choices">
        <button
          aria-pressed={query.mode === "changes"}
          onClick={() => choose({ mode: "changes" })}
        >
          Changes
        </button>
        <button
          aria-pressed={query.mode === "compare"}
          onClick={() =>
            choose({ mode: "compare", base: "HEAD", target: "WORKING_TREE" })
          }
        >
          Compare
        </button>
        {query.mode === "compare" && (
          <>
            <label>
              Base branch
              <select
                aria-label="Current base branch"
                value={query.base}
                onChange={(e) => choose({ ...query, base: e.target.value })}
              >
                <option value="HEAD">HEAD (committed)</option>
                {branches.branches.map((b) => (
                  <option key={b.ref} value={b.ref}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Target
              <select
                aria-label="Current target"
                value={query.target}
                onChange={(e) => choose({ ...query, target: e.target.value })}
              >
                <option value="WORKING_TREE">Working tree (saved)</option>
                <option value="HEAD">HEAD (committed)</option>
                {branches.branches.map((b) => (
                  <option key={b.ref} value={b.ref}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {(loading || error) && (
        <p role="status">
          {loading ? "Loading changed files…" : "Coverage incomplete/unknown."}
        </p>
      )}
      {scan?.files.some((file) => file.status === "unavailable") && (
        <p>
          Some source candidates are unavailable/unknown; enumeration is not
          proof of complete change coverage.
        </p>
      )}
      {scan?.coverage &&
        (!scan.coverage.allowed.complete ||
          error ||
          scan.coverage.restricted.candidatePaths > 0 ||
          scan.coverage.restricted.workingChanges === "unknown") && (
          <p className="coverage-scope">
            {(!scan.coverage.allowed.complete || error) &&
              "Changed-file coverage is incomplete/unknown."}
            {scan.coverage.restricted.workingChanges === "unknown" &&
              scan.coverage.restricted.candidatePaths === 0 &&
              "Restricted-source working changes are unknown."}
            {scan.coverage.restricted.candidatePaths > 0 &&
              ` ${scan.coverage.restricted.candidatePaths} restricted candidate paths not inspected; ${scan.coverage.restricted.knownChangedPaths} known committed/index changed paths excluded; ${scan.coverage.restricted.workingChanges === "unknown" ? "working change coverage unknown" : "restricted sources excluded"}.`}
          </p>
        )}
      <div className="current-review-layout">
        <nav
          className="git-file-list"
          aria-label="Changed files"
          data-inventory-ready={
            scan?.complete && !loading && !error ? "true" : "false"
          }
        >
          <div
            className="review-guide-choices"
            role="group"
            aria-label="Display guide"
          >
            {guideChoices}
          </div>
          {(["staged", "unstaged", "untracked", "compare"] as const).map(
            (group) => {
              const files =
                scan?.files.filter((file) => file.group === group) ?? [];
              return (
                files.length > 0 && (
                  <section key={group}>
                    <h2>{group === "compare" ? "Compared files" : group}</h2>
                    {files.map((file) => {
                      const pair = scan?.pairs.find(
                        (p) => p.fileId === file.id
                      );
                      return (
                        <div className="changed-file" key={file.id}>
                          <input
                            type="checkbox"
                            aria-label={`Viewed ${group} ${file.file}`}
                            checked={pair?.viewed ?? false}
                            disabled={
                              !pair?.identity ||
                              busy.has(file.id) ||
                              (!pair.viewed && (loading || !!error))
                            }
                            title={
                              pair && "disabledReason" in pair
                                ? pair.disabledReason
                                : "Manual progress only"
                            }
                            onChange={() => {
                              if (pair) mark(file, pair);
                            }}
                          />
                          <button
                            aria-label={`Open ${group} ${file.file}`}
                            aria-current={
                              selected === file.id ? "true" : undefined
                            }
                            onClick={() => openFile(file.id)}
                          >
                            {file.oldFile ? `${file.oldFile} → ` : ""}
                            {file.file}
                            <small>{file.status}</small>
                          </button>
                          {pair && "disabledReason" in pair && (
                            <small>{pair.disabledReason}</small>
                          )}
                        </div>
                      );
                    })}
                  </section>
                )
              );
            }
          )}
          {scan?.complete && scan.files.length === 0 && (
            <p>No allowed-path differences.</p>
          )}
        </nav>
        <div className="current-diff-host">
          {active && walk && (
            <button
              className="secondary saved-source-toggle"
              onClick={() => guide.expandSaved(!guide.savedOpen)}
            >
              {guide.savedOpen
                ? "Back to current diff"
                : "Read saved guide source"}
            </button>
          )}
          {active && guide.savedOpen && walk ? (
            <>
              <p className="saved-source-notice">
                Saved source versions, not the current diff.
              </p>
              <GuideDisplay guide={guide} />
            </>
          ) : active && guide.id && (!walk || guideStep) ? (
            <GuideDisplay
              guide={guide}
              step={guideStep}
              steps={
                walk?.steps.filter(
                  (step) =>
                    !selected ||
                    scan?.files.some((file) => file.id === step.fileId)
                ) ?? []
              }
              chooseStep={(step) => {
                if (selected) openFile(step.fileId);
                guide.chooseStep(step.id);
              }}
            >
              {currentView ? (
                <CurrentDiff
                  view={currentView}
                  focused={focused}
                  annotation={
                    matched
                      ? (side) => guide.annotation(matched, side, sourceCurrent)
                      : null
                  }
                />
              ) : (
                <p role={fileError ? "alert" : undefined}>
                  {fileError ||
                    "Current source is unavailable or opening. Saved source is available explicitly above."}
                </p>
              )}
            </GuideDisplay>
          ) : active && currentView ? (
            <>
              <CurrentDiff
                view={currentView}
                annotation={null}
                focused={focused}
              />
              {links.length > 0 && (
                <div className="optional-explanations">
                  {links.map((link) => (
                    <button
                      key={link.walkthroughId + link.stepId}
                      onClick={() => openGuide(link.walkthroughId, link.stepId)}
                    >
                      {link.title} · {link.stepTitle}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p role={fileError ? "alert" : undefined}>
              {fileError
                ? fileError
                : error && selected && !selectedListed
                  ? "Selected file was not reached. Choose a listed file or refresh the incomplete inventory."
                  : selected
                    ? "Opening complete available diff…"
                    : loading
                      ? "Reading changed files…"
                      : error
                        ? "Inventory unavailable."
                        : null}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
function CurrentDiff({
  view,
  annotation,
  focused,
}: {
  view: FileView;
  focused: boolean;
  annotation:
    ((side: "before" | "after") => ComparisonAnnotationContext) | null;
}) {
  const prepared = useMemo(() => {
    const step = (side: "before" | "after"): Step => {
      const source = view[side];
      return {
        id: view.file.id + side,
        title: side,
        source: { file: source.file },
        explanation: "",
        evidence: "source",
        snapshotHash: source.code?.hash ?? "",
        notes: [],
        stale: false,
        ...(source.code
          ? {
              code: {
                ...source.code,
                functionContext: view.functionContexts[side],
              },
            }
          : {}),
      };
    };
    return {
      rows: diffRows(view),
      before: step("before"),
      after: step("after"),
    };
  }, [view]);
  const rows = useMemo(
    () =>
      focused && prepared.rows ? focusedRows(prepared.rows) : prepared.rows,
    [focused, prepared.rows]
  );
  return (
    <>
      <h2>
        {view.file.oldFile ? `${view.file.oldFile} → ` : ""}
        {view.file.file}
      </h2>
      {!rows && (
        <p>
          {view.unavailable ??
            "Plain source — diff alignment unavailable for these raw source bytes."}
          {focused &&
            " Focused sections unavailable; showing available source without guessed alignment."}
        </p>
      )}
      {focused && rows && rows.before.length === 0 && (
        <p>No text changes in this source pair.</p>
      )}
      <div className="comparison-scroll">
        <div className="current-columns">
          {(["before", "after"] as const).map((side) => (
            <CurrentSide
              key={side}
              side={side}
              view={view}
              step={prepared[side]}
              rows={rows}
              context={annotation?.(side) ?? null}
            />
          ))}
        </div>
      </div>
    </>
  );
}
function CurrentSide({
  side,
  view,
  step,
  rows,
  context,
}: {
  side: "before" | "after";
  view: FileView;
  step: Step;
  rows: ReturnType<typeof focusedRows> | null;
  context: ComparisonAnnotationContext | null;
}) {
  const annotation = useComparisonAnnotations(context);
  const source = view[side];
  return (
    <section
      data-current-side={side}
      aria-label={side === "before" ? "Before changes" : "After changes"}
    >
      <h2>{side === "before" ? "Before" : "After"}</h2>
      <article className="authored-card current-file-card">
        <header>
          <p>{source.label}</p>
          <p className="git-source-path">
            {source.file} · {source.mode === "000000" ? "absent" : source.mode}
          </p>
        </header>
        {source.unavailable ? (
          <p>{source.unavailable}</p>
        ) : (
          <div className="code review-source">
            <FunctionContextLabel
              step={
                step.code &&
                rows &&
                (rows[side].includes("omitted") || rows[side].length === 0)
                  ? {
                      ...step,
                      code: {
                        ...step.code,
                        functionContext: {
                          status: "unknown",
                          reason: "Focused source omits function context",
                        },
                      },
                    }
                  : step
              }
            />
            <CodeLines
              step={step}
              annotationStep={annotation.step}
              explanationColors={annotation.colors}
              selectRange={annotation.selectRange}
              clearSelection={() => annotation.selectRange?.(null)}
              reveal={annotation.reveal}
              walkthroughId=""
              full
              exact
              snapshot
              rowLines={rows?.[side] ?? rawLineNumbers(source.content ?? "")}
              changedLines={side === "before" ? rows?.removed : rows?.added}
              changeKind={side === "before" ? "removed" : "added"}
            />
            {source.content === "" && (
              <p>
                {source.mode === "000000"
                  ? "No file on this side."
                  : "Empty file on this side."}
              </p>
            )}
            {source.content !== "" &&
              source.content !== undefined &&
              !source.content.endsWith("\n") &&
              (!rows ||
                rows[side].includes(rawLineNumbers(source.content).length)) && (
                <p className="eof-marker">No newline at end of file.</p>
              )}
          </div>
        )}
      </article>
      <div className="current-annotations" data-git-side={side}>
        {annotation.content}
      </div>
    </section>
  );
}
