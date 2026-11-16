import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  GitChangedFile,
  GitChangesPage,
  GitQuery,
  GitViewedPair,
  ComparisonWalkthroughStep,
  ToolResults,
  Step,
  Walkthrough,
} from "../types.mjs";
import { errorMessage } from "../types.mjs";
import {
  listGitBranches,
  listGitChanges,
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
import { ReadonlyExplanation } from "./review-explanations";
import { explanationHomes } from "./review-explanation-homes";
import { WalkthroughReviewNotes } from "./walkthrough-review-notes";
import { walkthroughStepInFile } from "./walkthrough-review-source";
import {
  useReviewFlowPresentation,
  type ReviewFlowDisplay,
  type ReviewFlowMode,
} from "./review-flow-presentation";
import { WalkthroughFlow } from "./walkthrough-flow";
import { useReviewFlow, type ReviewFlowRequest } from "./review-flow";
import { reviewFlowSides, type ReviewFlowSide } from "./review-flow-source";
import type { FlowSourceFocus } from "./flow-source";
import type { RefreshTarget } from "./manual-refresh";
import { useComparisonAnnotations } from "./comparison-annotations";
import type { ComparisonAnnotationContext } from "./comparison-annotations";
import {
  ReviewFileWindow,
  useReviewFileLoader,
  useFileJump,
} from "./review-file-window";

function sameQuery(a: GitQuery, b: GitQuery) {
  return a.mode === "changes"
    ? b.mode === "changes"
    : b.mode === "compare" && a.base === b.base && a.target === b.target;
}
type Inventory = GitChangesPage & {
  pairs: readonly GitViewedPair[];
  query: GitQuery;
  owner: symbol;
};
type FileView = ToolResults["get_git_file"];
const groups = ["staged", "unstaged", "untracked", "compare"] as const;
export function CurrentChanges({
  active,
  navigationHidden = false,
  guide,
  walkthrough: readingWalkthrough = null,
  flowWalkthrough = readingWalkthrough,
  walkthroughStepId,
  guideChoices,
  focused,
  flowRequest,
  flowBlocked = false,
  popOutFlow,
  flowPopOutBusy,
  onFlowDisplay,
  onRefreshTarget,
  manualRefresh,
  refreshBusy = false,
  openGuide,
}: {
  active: boolean;
  navigationHidden?: boolean;
  guide: ChangeReview;
  walkthrough?: Walkthrough | null;
  flowWalkthrough?: Walkthrough | null;
  walkthroughStepId?: string | null;
  guideChoices?: ReactNode;
  focused: boolean;
  flowRequest?: ReviewFlowRequest | null;
  flowBlocked?: boolean;
  popOutFlow?: () => Promise<boolean>;
  flowPopOutBusy?: boolean;
  onFlowDisplay?: (display: ReviewFlowDisplay) => void;
  onRefreshTarget?: (target: RefreshTarget | null) => void;
  manualRefresh?: () => void;
  refreshBusy?: boolean;
  openGuide: (id: string, step?: string) => void;
}) {
  const [query, setQuery] = useState<GitQuery>({ mode: "changes" });
  const [showFlow, setShowFlow] = useState(false);
  const [flowMode, setFlowMode] = useState<ReviewFlowMode>("after");
  const canvasKey = JSON.stringify([
    active,
    showFlow,
    flowMode,
    flowBlocked,
    guide.id,
    flowWalkthrough?.id,
    flowWalkthrough?.flowState,
  ]);
  const canvas = useRef({ key: canvasKey, life: Symbol("review Flow canvas") }),
    canvasLive = useRef(true);
  if (canvas.current.key !== canvasKey)
    canvas.current = { key: canvasKey, life: Symbol("review Flow canvas") };
  useEffect(() => {
    canvasLive.current = true;
    return () => {
      canvasLive.current = false;
    };
  }, []);
  async function detachFlow() {
    if (!active || !showFlow || flowBlocked || !popOutFlow) return;
    const life = canvas.current.life;
    const opened = await popOutFlow();
    if (opened && canvasLive.current && canvas.current.life === life)
      setShowFlow(false);
  }
  const [branches, setBranches] = useState<ToolResults["list_git_branches"]>({
    branches: [],
  });
  const [scan, setScan] = useState<Inventory | null>(null);
  const scanRef = useRef(scan);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(Symbol("inventory"));
  const actions = useRef(
    new Map<string, { instance: symbol; version: number }>()
  );
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const loader = useReviewFileLoader();
  const section = useRef<HTMLElement>(null);
  const files = useRef(new Map<string, HTMLElement>());
  const jump = useRef<symbol | null>(null);
  const userSelectedFile = useRef(false);
  const flowJump = useRef<{ token: symbol; cancel: () => void } | null>(null);
  const showingCurrent = useRef(false);
  showingCurrent.current = active;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refreshScope = useMemo(
    () => Symbol("review refresh view"),
    [active, query, guide.id, flowWalkthrough?.id]
  );
  const refreshOwner = useRef<symbol | null>(refreshScope);
  refreshOwner.current = refreshScope;
  const manual = useRef<{
    scope: symbol;
    current: () => boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
    inventory?: symbol;
    fileId?: string;
    complete?: boolean;
  } | null>(null);
  const refreshedSources = useRef(
    new Map<string, { owner: symbol; error?: string }>()
  );
  function finishManualRefresh() {
    const request = manual.current;
    if (!request?.complete) return;
    const source = request.fileId
      ? refreshedSources.current.get(request.fileId)
      : null;
    if (request.fileId && source?.owner !== request.inventory) return;
    manual.current = null;
    refreshedSources.current.clear();
    if (!request.current()) request.reject(Error("Refresh view changed."));
    else if (source?.error) request.reject(Error(source.error));
    else request.resolve();
  }
  const refreshTarget = useMemo<RefreshTarget>(
    () => ({
      current: () =>
        showingCurrent.current && refreshOwner.current === refreshScope,
      run: (current) =>
        new Promise<void>((resolve, reject) => {
          if (!current() || refreshOwner.current !== refreshScope) {
            resolve();
            return;
          }
          manual.current?.reject(Error("Refresh was superseded."));
          manual.current = { scope: refreshScope, current, resolve, reject };
          epoch.current = Symbol("manual refresh");
          actions.current.clear();
          setRefresh((n) => n + 1);
        }),
    }),
    [refreshScope]
  );
  useLayoutEffect(() => {
    refreshOwner.current = refreshScope;
    onRefreshTarget?.(active ? refreshTarget : null);
    return () => {
      const changed = refreshOwner.current !== refreshScope;
      if (!changed) refreshOwner.current = null;
      if (manual.current?.scope === refreshScope) {
        manual.current.reject(Error("Refresh view changed."));
        manual.current = null;
        if (changed) {
          // A canceled manual scan cannot leave the replacement view loading.
          // Normal note/Flow selection alone does not rebuild its inventory.
          epoch.current = Symbol("retired manual scan");
          setRefresh((n) => n + 1);
        }
      }
    };
  }, [active, refreshScope, refreshTarget, onRefreshTarget]);
  const instance = epoch.current;
  const fileJump = useFileJump(active, instance);
  const explanations = useMemo(
    () => explanationHomes(guide.walkthrough?.steps ?? [], scan?.files ?? []),
    [guide.walkthrough?.steps, scan?.files]
  );
  const inventory = useMemo(
    () => ({
      current: () => showingCurrent.current && epoch.current === instance,
    }),
    [instance]
  );
  const presentation = useReviewFlowPresentation({
    active:
      active &&
      !flowBlocked &&
      !loading &&
      !!scan &&
      scan.owner === instance &&
      sameQuery(scan.query, query),
    mode: flowMode,
    walkthrough: flowWalkthrough,
    query,
    scan,
    owner: inventory,
    load: loader,
    reviewId: guide.id,
  });
  useLayoutEffect(() => {
    onFlowDisplay?.(presentation.display);
  }, [onFlowDisplay, presentation.display]);
  const reviewFlow = useReviewFlow({
    active: active && !flowBlocked,
    visible: showFlow,
    walkthrough: presentation.display.walkthrough,
    presentation,
    reviewId: guide.id,
    scan,
    owner: inventory,
    load: loader,
    request: flowRequest,
    reveal: (selection) => {
      userSelectedFile.current = true;
      jump.current = Symbol("Flow reveal");
      setSelected(selection.target!.fileId);
      const node = files.current.get(selection.target!.fileId);
      if (node) {
        flowJump.current?.cancel();
        flowJump.current = {
          token: selection.token,
          cancel: fileJump.reveal(node),
        };
      }
    },
  });
  useEffect(() => {
    const selection = reviewFlow.selection,
      root = section.current;
    if (!selection || !root) return;
    let live = true;
    const reveal = () => {
      if (
        !live ||
        !reviewFlow.current(selection) ||
        root.hidden ||
        root.ownerDocument.querySelector("dialog[open]")
      )
        return;
      const article = files.current.get(selection.target!.fileId),
        side = selection.target!.sides.includes("after") ? "after" : "before";
      const marker = article?.querySelector<HTMLElement>(
        `[data-current-side="${side}"] [data-flow-source]`
      );
      if (marker) {
        flowJump.current?.cancel();
        flowJump.current = {
          token: selection.token,
          cancel: fileJump.reveal(marker),
        };
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(reveal);
    observer.observe(root, { childList: true, subtree: true });
    const frame = requestAnimationFrame(reveal);
    return () => {
      live = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (flowJump.current?.token === selection.token) {
        flowJump.current.cancel();
        flowJump.current = null;
      }
    };
  }, [reviewFlow.selection]);
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
    const requested = manual.current;
    if (requested) requested.inventory = instance;
    refreshedSources.current.clear();
    const current = () =>
      epoch.current === instance && (!requested || requested.current());
    setError("");
    setLoading(true);
    display(null);
    void (async () => {
      const refs = await listGitBranches();
      if (epoch.current !== instance) return;
      setBranches(refs);
      let page = await listGitChanges({ query });
      const files = [...page.files],
        cursors = new Set<string>();
      while (epoch.current === instance) {
        display({
          ...page,
          files: [...files],
          pairs: [],
          query,
          owner: instance,
        });
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
      display({
        ...page,
        files,
        pairs: progress.pairs,
        query,
        owner: instance,
      });
      setSelected((old) =>
        files.some((file) => file.id === old) ? old : (files[0]?.id ?? null)
      );
      setLoading(false);
      if (requested && manual.current === requested && current()) {
        if (!page.coverage.allowed.complete)
          throw Error("Comparison coverage is incomplete/unknown.");
        if (files.some((file) => file.status === "unavailable")) {
          manual.current = null;
          refreshedSources.current.clear();
          requested.reject(Error("Some comparison sources are unavailable."));
          return;
        }
        requested.fileId = (
          files.find((file) => file.id === selectedRef.current) ?? files[0]
        )?.id;
        requested.complete = true;
        finishManualRefresh();
      }
    })()
      .catch((e: unknown) => {
        if (current()) {
          setError(errorMessage(e) + " Coverage is incomplete/unknown.");
          setLoading(false);
          if (requested && manual.current === requested) {
            manual.current = null;
            requested.reject(e);
          }
        }
      })
      .finally(() => {
        if (requested && manual.current === requested && !requested.current()) {
          manual.current = null;
          requested.reject(Error("Refresh view changed."));
        }
      });
    return () => {
      epoch.current = Symbol("retired inventory");
      jump.current = null;
      actions.current.clear();
      if (requested && manual.current === requested) {
        manual.current = null;
        requested.reject(Error("Refresh was superseded. Try again."));
      }
    };
  }, [active, query, refresh]);
  useEffect(() => {
    if (!active || !scan?.complete || loading || refreshBusy) return;
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
  }, [active, scan?.listId, scan?.complete, loading, refreshBusy]);
  function openFile(fileId: string, userAction = true, noteStepId?: string) {
    if (userAction) userSelectedFile.current = true;
    setSelected(fileId);
    const request = Symbol("file reveal"),
      owner = epoch.current;
    jump.current = request;
    requestAnimationFrame(() => {
      const node = files.current.get(fileId),
        parent = section.current;
      if (
        jump.current !== request ||
        epoch.current !== owner ||
        !showingCurrent.current ||
        !node?.isConnected ||
        !parent
      )
        return;
      fileJump.reveal(node, noteStepId);
    });
  }
  function openExplanation(stepId: string, userAction = true) {
    if (guide.stepId !== stepId) guide.chooseStep(stepId);
    const home = [...explanations.byFile].find(([, steps]) =>
      steps.some((step) => step.id === stepId)
    );
    if (home) {
      openFile(home[0], userAction);
      return;
    }
    setSelected(null);
    const request = Symbol("explanation reveal"),
      owner = epoch.current;
    jump.current = request;
    requestAnimationFrame(() => {
      const node = files.current.get("explanation-" + stepId);
      if (
        jump.current === request &&
        epoch.current === owner &&
        showingCurrent.current &&
        node?.isConnected
      )
        fileJump.reveal(node);
    });
  }
  function choose(value: GitQuery) {
    if (!userSelectedFile.current) entryPending.current = true;
    epoch.current = Symbol("comparison choices changed");
    actions.current.clear();
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
  function progress(file: GitChangedFile, inFile = false) {
    const pair = scan?.pairs.find((p) => p.fileId === file.id);
    return (
      <input
        type="checkbox"
        aria-label={`${inFile ? "File viewed" : "Viewed"} ${file.group} ${file.file}`}
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
    );
  }
  const walk = guide.walkthrough;
  const entryPending = useRef(false),
    wasActive = useRef(false),
    entryWalkthrough = useRef<string | null>(null);
  useEffect(() => {
    if (active && !wasActive.current) {
      entryPending.current = true;
      if (entryWalkthrough.current !== readingWalkthrough?.id)
        userSelectedFile.current = false;
      entryWalkthrough.current = readingWalkthrough?.id ?? null;
    }
    wasActive.current = active;
  }, [active, readingWalkthrough?.id]);
  useEffect(() => {
    if (
      !active ||
      !entryPending.current ||
      loading ||
      !scan?.complete ||
      !inventory.current()
    )
      return;
    if (
      userSelectedFile.current &&
      scan.files.some((file) => file.id === selected)
    ) {
      entryPending.current = false;
      return;
    }
    if (!readingWalkthrough && guide.id && !walk) return;
    const annotated =
      readingWalkthrough?.steps.filter((step) =>
        step.notes.some((note) => !note.archived)
      ) ?? [];
    const step =
      annotated.find((step) => step.id === walkthroughStepId) ?? annotated[0];
    entryPending.current = false;
    if (step) {
      // This is a display jump, not source admission. Each side still checks
      // its exact attachment/version before marking or editing anything.
      const file = scan.files.find((file) => walkthroughStepInFile(step, file));
      openFile(file?.id ?? "walkthrough-" + step.id, false, step.id);
    } else if (walk?.steps[0])
      openExplanation(guide.stepId ?? walk.steps[0].id, false);
  }, [
    active,
    scan,
    selected,
    loading,
    inventory,
    readingWalkthrough,
    walkthroughStepId,
    walk,
    guide.stepId,
  ]);
  const guideStatus = guide.error
    ? "Could not load the guide."
    : !walk
      ? "Opening guide…"
      : "";
  return (
    <>
      <div
        className="review-flow-region"
        hidden={!active}
        data-review-flow-mode={flowMode}
        data-flow-after-state={
          flowMode === "after" ? presentation.status : undefined
        }
      >
        <div className="review-flow-heading">
          <button
            type="button"
            aria-expanded={showFlow}
            aria-controls="review-flow-canvas"
            onClick={() => setShowFlow((value) => !value)}
          >
            Flow
          </button>
          <div
            className="review-flow-modes"
            role="group"
            aria-label="Flow source"
          >
            <button
              type="button"
              aria-pressed={flowMode === "after"}
              onClick={() => setFlowMode("after")}
            >
              After
            </button>
            <button
              type="button"
              aria-pressed={flowMode === "walkthrough"}
              onClick={() => setFlowMode("walkthrough")}
            >
              Walkthrough
            </button>
          </div>
          <div
            className="review-flow-status"
            data-review-flow-status
            role="status"
            aria-live="polite"
          >
            <span data-review-flow-source>{presentation.display.label}</span>
            {flowWalkthrough && (
              <span data-review-flow-owner>{flowWalkthrough.title}</span>
            )}
            {(showFlow && presentation.display.message) || reviewFlow.message}
            {reviewFlow.choices.map((target) => (
              <button
                key={target.fileId}
                onClick={() => reviewFlow.choose(target)}
              >
                {target.view.file.group} · {target.sides.join(" / ")} ·{" "}
                {target.view.file.file}
              </button>
            ))}
          </div>
        </div>
        <div id="review-flow-canvas" hidden={!showFlow}>
          {active && showFlow && presentation.display.walkthrough ? (
            <WalkthroughFlow
              id="review-flow-panel"
              walkthrough={presentation.display.walkthrough}
              changes={presentation.display.changes}
              previewSourceLabel={
                flowMode === "after" ? "After source" : undefined
              }
              hidden={!active || !showFlow || flowBlocked}
              selectCard={reviewFlow.select}
              popOut={popOutFlow ? detachFlow : undefined}
              popOutBusy={flowPopOutBusy}
            />
          ) : active && showFlow ? (
            <p role="status">{presentation.display.message}</p>
          ) : null}
        </div>
      </div>
      <section
        ref={section}
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
            disabled={refreshBusy}
            aria-busy={refreshBusy}
            onClick={() => {
              if (manualRefresh) manualRefresh();
              else {
                epoch.current = Symbol("refresh");
                actions.current.clear();
                setRefresh((n) => n + 1);
              }
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
        {guide.error && <p role="alert">{guide.error}</p>}
        {(loading || error) && (
          <p role="status">
            {loading
              ? "Loading changed files…"
              : "Coverage incomplete/unknown."}
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
        <div
          className={
            "current-review-layout" +
            (navigationHidden ? " navigation-hidden" : "")
          }
        >
          <nav
            id="comparison-navigation"
            hidden={navigationHidden}
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
            {groups.map((group) => {
              const groupFiles =
                scan?.files.filter((file) => file.group === group) ?? [];
              return (
                groupFiles.length > 0 && (
                  <section key={group}>
                    <h2>{group === "compare" ? "Compared files" : group}</h2>
                    {groupFiles.map((file) => {
                      const pair = scan?.pairs.find(
                        (p) => p.fileId === file.id
                      );
                      return (
                        <div className="changed-file" key={file.id}>
                          {progress(file)}
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
            })}
            {scan?.complete && scan.files.length === 0 && (
              <p>No allowed-path differences.</p>
            )}
          </nav>
          <div className="current-diff-host">
            {active && (
              <div ref={fileJump.container} className="review-file-stream">
                {groups
                  .flatMap((group) =>
                    (scan?.files ?? []).filter((file) => file.group === group)
                  )
                  .map((file) => (
                    <article
                      key={scan!.listId + file.id}
                      ref={(node) => {
                        if (node) files.current.set(file.id, node);
                        else files.current.delete(file.id);
                      }}
                      className="review-file"
                      data-review-file={file.id}
                      data-review-group={file.group}
                      data-review-path={file.file}
                      data-review-active={
                        selected === file.id ? "true" : "false"
                      }
                      aria-label={`${file.group} ${file.file}`}
                    >
                      <header className="review-file-heading">
                        <div>
                          <small>
                            {file.group} · {file.status}
                          </small>
                          <h2>
                            {file.oldFile ? `${file.oldFile} → ` : ""}
                            {file.file}
                          </h2>
                          {(explanations.byFile.get(file.id) ?? []).map(
                            (step) => (
                              <small
                                key={step.id}
                                className="review-step-label"
                                data-review-step-title={step.title}
                              >
                                {step.title}
                              </small>
                            )
                          )}
                          {((explanations.byFile.get(file.id)?.length ?? 0) >
                            0 ||
                            readingWalkthrough?.steps.some(
                              (step) =>
                                walkthroughStepInFile(step, file) &&
                                step.notes.some((note) => !note.archived)
                            )) && (
                            <button
                              className="review-notes-jump"
                              aria-label={`Notes and Variables for ${file.group} ${file.file}`}
                              onClick={() => {
                                const local =
                                  explanations.byFile.get(file.id) ?? [];
                                const step =
                                  local.find(
                                    (step) => step.id === guide.stepId
                                  ) ?? local[0];
                                if (step) openExplanation(step.id);
                                else openFile(file.id);
                              }}
                            >
                              Notes and Variables
                            </button>
                          )}
                        </div>
                        <label>{progress(file, true)}Viewed</label>
                      </header>
                      <ReviewFileWindow
                        active={active}
                        selected={selected === file.id}
                      >
                        <CurrentFile
                          file={file}
                          listId={scan!.listId}
                          explanations={explanations.byFile.get(file.id) ?? []}
                          query={query}
                          inventory={inventory}
                          loader={loader}
                          sourceRead={(value) => {
                            if (!inventory.current() || !manual.current) return;
                            const error =
                              value instanceof Error
                                ? value.message
                                : (value.unavailable ??
                                  value.before.unavailable ??
                                  value.after.unavailable);
                            refreshedSources.current.set(file.id, {
                              owner: instance,
                              error,
                            });
                            finishManualRefresh();
                          }}
                          guide={guide}
                          walkthrough={readingWalkthrough}
                          flowWalkthrough={presentation.display.walkthrough}
                          walkthroughSteps={(
                            readingWalkthrough?.steps.filter((step) =>
                              walkthroughStepInFile(step, file)
                            ) ?? []
                          ).sort(
                            (a, b) =>
                              Number(b.id === walkthroughStepId) -
                              Number(a.id === walkthroughStepId)
                          )}
                          focused={focused}
                          flowSelection={reviewFlow.selection}
                          flowCurrent={reviewFlow.current}
                          selected={selected === file.id}
                          openGuide={openGuide}
                        />
                      </ReviewFileWindow>
                    </article>
                  ))}
                {walk &&
                  explanations.unmatched.map((step) => (
                    <article
                      key={"unmatched-" + walk.id + step.id}
                      className="review-file unmatched-explanation"
                      ref={(node) => {
                        if (node)
                          files.current.set("explanation-" + step.id, node);
                        else files.current.delete("explanation-" + step.id);
                      }}
                      data-unmatched-active={
                        guide.stepId === step.id ? "true" : "false"
                      }
                      data-unmatched-explanation={step.id}
                    >
                      <header className="review-file-heading">
                        <div>
                          <h2>{step.file.file}</h2>
                          <small data-review-step-title={step.title}>
                            {step.title}
                          </small>
                          <button
                            aria-label={`Notes and Variables for comparison ${step.title}`}
                            onClick={() => openExplanation(step.id)}
                          >
                            Notes and Variables
                          </button>
                          <p>
                            {loading
                              ? "Current comparison is still loading."
                              : error
                                ? "Current source is unavailable."
                                : "Not uniquely included in the current comparison."}{" "}
                            Its explanations remain below.
                          </p>
                        </div>
                      </header>
                      <ReviewFileWindow
                        active={active}
                        selected={guide.stepId === step.id}
                      >
                        <div className="comparison-scroll">
                          <div className="unmatched-explanation-columns">
                            {(["before", "after"] as const).map((side) => (
                              <section key={side} data-explanation-side={side}>
                                <h2>
                                  {side === "before"
                                    ? "Before explanations"
                                    : "After explanations"}
                                </h2>
                                <ReadonlyExplanation
                                  step={step}
                                  side={side}
                                  status={
                                    loading || error ? "unverified" : "outdated"
                                  }
                                  query={walk.query}
                                  walkthroughId={walk.id}
                                  drafts={guide.drafts}
                                  context={guide.annotation(
                                    step,
                                    side,
                                    () => showingCurrent.current
                                  )}
                                />
                              </section>
                            ))}
                          </div>
                        </div>
                      </ReviewFileWindow>
                    </article>
                  ))}
                {readingWalkthrough?.steps
                  .filter(
                    (step) =>
                      !(scan?.files ?? []).some((file) =>
                        walkthroughStepInFile(step, file)
                      )
                  )
                  .map((step) => (
                    <article
                      className="review-file"
                      key={"walkthrough-" + readingWalkthrough.id + step.id}
                      data-unmatched-walkthrough={step.id}
                      ref={(node) => {
                        if (node)
                          files.current.set("walkthrough-" + step.id, node);
                        else files.current.delete("walkthrough-" + step.id);
                      }}
                    >
                      <header className="review-file-heading">
                        <div>
                          <h2>{step.source.file}</h2>
                          <p>
                            Walkthrough card not included in this comparison.
                            Its Notes and Variables remain below.
                          </p>
                        </div>
                      </header>
                      <ReviewFileWindow active={active} selected={false}>
                        <WalkthroughReviewNotes
                          walkthrough={readingWalkthrough}
                          steps={[step]}
                          view={null}
                          side="after"
                        />
                      </ReviewFileWindow>
                    </article>
                  ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function CurrentFile({
  file,
  listId,
  explanations,
  walkthrough,
  flowWalkthrough,
  walkthroughSteps,
  query,
  inventory,
  loader,
  sourceRead,
  guide,
  focused,
  flowSelection,
  flowCurrent,
  selected,
  openGuide,
}: {
  file: GitChangedFile;
  listId: string;
  explanations: readonly ComparisonWalkthroughStep[];
  walkthrough: Walkthrough | null;
  flowWalkthrough: Walkthrough | null;
  walkthroughSteps: readonly Step[];
  query: GitQuery;
  inventory: { current: () => boolean };
  loader: ReturnType<typeof useReviewFileLoader>;
  sourceRead: (value: FileView | Error) => void;
  guide: ChangeReview;
  focused: boolean;
  flowSelection: ReturnType<typeof useReviewFlow>["selection"];
  flowCurrent: ReturnType<typeof useReviewFlow>["current"];
  selected: boolean;
  openGuide: (id: string, step?: string) => void;
}) {
  const [view, setView] = useState<FileView | null>(null);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<ToolResults["list_git_explanations"]>([]);
  const owner = useRef(Symbol("file"));
  useEffect(() => {
    const token = Symbol("file");
    owner.current = token;
    setView(null);
    setError("");
    const current = () => owner.current === token && inventory.current();
    void loader(listId, file.id, current)
      .then((next) => {
        if (!current() || !next) return;
        if (next.file.id !== file.id)
          throw Error("Source identity changed. Refresh the comparison.");
        setView(next);
        sourceRead(next);
      })
      .catch((e: unknown) => {
        if (current()) {
          setError(errorMessage(e));
          sourceRead(Error(errorMessage(e)));
        }
      });
    return () => {
      owner.current = Symbol("retired file");
    };
  }, [listId, file.id, inventory, loader]);
  useEffect(() => {
    let live = true;
    const token = owner.current;
    setLinks([]);
    if (view && inventory.current())
      void listGitExplanations({
        query,
        fileId: file.id,
        binding: view.binding,
      })
        .then((result) => {
          if (live && owner.current === token && inventory.current())
            setLinks(result);
        })
        .catch(() => {
          /* Optional explanations never block the source stream. */
        });
    return () => {
      live = false;
    };
  }, [view, query, file.id, guide.id, inventory]);
  const token = owner.current;
  const sourceCurrent = () => owner.current === token && inventory.current();
  const walk = guide.walkthrough,
    steps = explanations;
  const matching =
    view && sourceCurrent() && walk && sameQuery(query, walk.query)
      ? steps.filter(
          (step) =>
            step.fileId === view.file.id &&
            step.binding === view.binding &&
            links.some(
              (link) =>
                link.walkthroughId === walk.id && link.stepId === step.id
            )
        )
      : [];
  const step = steps.find((step) => step.id === guide.stepId) ?? steps[0];
  const matched = step && matching.find((item) => item.id === step.id);
  const visibleExplanations = (side: "before" | "after") => (
    <>
      {walk
        ? steps
            .filter((item) => item.id !== matched?.id)
            .map((item) => (
              <ReadonlyExplanation
                key={item.id}
                step={item}
                side={side}
                status={
                  matching.some((match) => match.id === item.id)
                    ? "current"
                    : !view ||
                        (sameQuery(query, walk.query) &&
                          item.fileId === view.file.id &&
                          item.binding === view.binding)
                      ? "unverified"
                      : "outdated"
                }
                query={walk.query}
                walkthroughId={walk.id}
                drafts={guide.drafts}
                context={guide.annotation(item, side, sourceCurrent)}
              />
            ))
        : null}
      <WalkthroughReviewNotes
        walkthrough={walkthrough}
        steps={walkthroughSteps}
        view={sourceCurrent() ? view : null}
        side={side}
      />
    </>
  );
  const flowFocus =
    flowSelection &&
    flowCurrent(flowSelection) &&
    sourceCurrent() &&
    view &&
    flowSelection.target?.fileId === file.id &&
    flowSelection.target.listId === listId &&
    flowSelection.target.binding === view.binding
      ? flowSelection.focus
      : null;
  const flowSides =
    flowFocus && view
      ? reviewFlowSides(flowWalkthrough, flowFocus, view).filter((side) =>
          flowSelection?.target?.sides.includes(side)
        )
      : [];
  const content =
    view && sourceCurrent() ? (
      <CurrentDiff
        view={view}
        focused={focused}
        flowFocus={flowFocus}
        flowSides={flowSides}
        explanations={visibleExplanations}
        annotation={
          matched
            ? (side) => guide.annotation(matched, side, sourceCurrent)
            : null
        }
      />
    ) : (
      <>
        <p role={error ? "alert" : "status"}>
          {error || "Opening complete available diff…"}
        </p>
        <div className="comparison-scroll">
          <div className="unmatched-explanation-columns">
            {(["before", "after"] as const).map((side) => (
              <section key={side}>{visibleExplanations(side)}</section>
            ))}
          </div>
        </div>
      </>
    );
  return (
    <div
      className="current-file-body"
      data-source-state={
        error ? "error" : view && sourceCurrent() ? "ready" : "loading"
      }
    >
      {matched && (
        <p className="current-guide-status" role="status">
          Explanations for these exact source versions.
        </p>
      )}
      {guide.id && walk && step ? (
        <GuideDisplay
          guide={guide}
          id={selected ? "git-comparisons" : `review-guide-${file.id}`}
          step={step}
          steps={steps}
        >
          {content}
        </GuideDisplay>
      ) : (
        <>
          {content}
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
      )}
    </div>
  );
}
function CurrentDiff({
  view,
  annotation,
  explanations,
  focused,
  flowFocus,
  flowSides,
}: {
  flowFocus: FlowSourceFocus | null;
  flowSides: ReviewFlowSide[];
  view: FileView;
  focused: boolean;
  explanations: (side: "before" | "after") => ReactNode;
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
      focused && prepared.rows
        ? focusedRows(
            prepared.rows,
            flowFocus && flowSides.length
              ? {
                  side: flowSides.includes("after") ? "after" : "before",
                  startLine: flowFocus.node.attachment.startLine,
                  endLine: flowFocus.node.attachment.endLine,
                }
              : undefined
          )
        : prepared.rows,
    [focused, prepared.rows, flowFocus, flowSides.join(",")]
  );
  return (
    <>
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
              explanations={explanations(side)}
              flowSource={
                flowFocus && flowSides.includes(side)
                  ? flowFocus.node.attachment
                  : undefined
              }
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
  explanations,
  flowSource,
}: {
  flowSource?: FlowSourceFocus["node"]["attachment"];
  side: "before" | "after";
  view: FileView;
  step: Step;
  rows: ReturnType<typeof focusedRows> | null;
  context: ComparisonAnnotationContext | null;
  explanations: ReactNode;
}) {
  const annotation = useComparisonAnnotations(context);
  const source = view[side];
  return (
    <section
      data-current-side={side}
      aria-label={side === "before" ? "Before changes" : "After changes"}
    >
      <h2>{side === "before" ? "Before" : "After"}</h2>
      <div className="current-annotations" data-git-side={side}>
        <div className="review-annotation-scroll">
          {context && (
            <div
              data-inline-explanation={context.view.id}
              data-explanation-status="current"
            >
              {annotation.content}
            </div>
          )}
          {explanations}
        </div>
      </div>
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
              flowSource={flowSource}
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
    </section>
  );
}
