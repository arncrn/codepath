import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolve, follow, hash } from "./indexer.mjs";
import { createSourceProject } from "./source-project.mjs";
import { validateWalkthrough } from "./walkthrough-validation.mjs";
import {
  validateComparisonNotes,
  readComparisonNotes,
  saveComparisonNote,
  deleteComparisonNote,
} from "./comparison-notes.mjs";
import {
  captureChangeReview,
  readChangeReview,
  validateChangeReviewState,
} from "./change-reviews.mjs";
import {
  authorComparisonWalkthrough,
  assertComparisonBudget,
  readComparisonWalkthrough,
  validateComparisonWalkthroughs,
  comparisonStep,
  saveWalkthroughNote,
} from "./comparison-walkthroughs.mjs";
import {
  validateGitViewed,
  readGitViewed,
  changeGitViewed,
} from "./git-viewed.mjs";
import { resolveReference } from "./references.mjs";
import { buildSourceUsageIndex } from "./source-usage.mjs";
import type {
  WorkspaceState,
  SavedStep,
  SavedWalkthrough,
  Walkthrough,
  Overview,
  ToolArgs,
  ToolName,
  ToolResults,
  SourceRef,
  StepInput,
  RunEvent,
  GitFileView,
  ComparisonNotes,
  ComparisonNoteInput,
  ComparisonWalkthroughInput,
  GitQuery,
  AdmittedGitFile,
  WalkthroughComparisonNoteInput,
} from "./types.mjs";
import { errorMessage, parseCallbackRole } from "./types.mjs";
import {
  applyAnnotationOperation,
  hydrateAttachments,
  isAnnotationOperation,
  noteRevision,
  validateAnnotationState,
} from "./annotations.mjs";
// Dynamic JSON arguments still pass through the existing runtime guards below.
type Input = Partial<{
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  query: string;
  cursor: string;
  notApplicable: unknown;
  source: SourceRef;
  line: number;
  column: number;
  title: string;
  description: string;
  steps: StepInput[];
  expectedRevision: number;
  walkthroughId: string;
  stepId: string;
  body: string;
  author: string;
  mode: "recorded" | "example";
  label: string;
  origin: string;
  events: RunEvent[];
}>;
export function openWorkspace(root: string) {
  root = fs.realpathSync(root);
  const dir = path.join(root, ".codepaths"),
    file = path.join(dir, "workspace.json");
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
    throw Error(".codepaths must not be a symlink.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw Error("workspace.json must not be a symlink.");
  const isNew = !fs.existsSync(file);
  let state: WorkspaceState = isNew
    ? { format: 1, revision: 0, paths: [], runs: [], focus: null }
    : JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    state.format !== 1 ||
    !Array.isArray(state.paths) ||
    !Array.isArray(state.runs)
  )
    throw Error("Unknown workspace format.");
  validateAnnotationState(state);
  validateChangeReviewState(state.changeReviews);
  validateComparisonNotes(state.comparisonNotes);
  validateComparisonWalkthroughs(state.comparisonWalkthroughs);
  validateGitViewed(state.gitViewed);
  for (const walkthrough of state.paths)
    for (const step of walkthrough.steps) parseCallbackRole(step.callbackRole);
  const sources = createSourceProject(root);
  const index = sources.index;
  const refresh = () => sources.refresh();
  const save = () => {
    state.revision++;
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  };
  function need(condition: unknown, message: string): asserts condition {
    if (!condition) throw Error(message);
  }
  const get = (id: string | undefined) => {
    const p = state.paths.find((p) => p.id === id);
    need(p, "Walkthrough not found.");
    return p;
  };
  const hydrate = (p: SavedWalkthrough): Walkthrough => {
    sources.watch(p.steps.map((step) => step.source.file));
    return {
      ...p,
      steps: p.steps.map((s) => {
        try {
          const code = resolve(root, index, s.source);
          return {
            ...s,
            code,
            stale:
              !!s.explanationReviewRequired || s.snapshotHash !== code.hash,
            explanationAttachments: hydrateAttachments(
              s.explanationAttachments,
              code
            ),
            notes: s.notes.map((n) => ({
              ...n,
              attachments: hydrateAttachments(n.attachments, code),
              stale: !!n.reviewRequired || n.hash !== code.hash,
            })),
          };
        } catch (e) {
          return { ...s, error: errorMessage(e), stale: true };
        }
      }),
    };
  };
  let noteUpdateWarning: string | null = null;
  function overview(walkthroughId?: string): Overview {
    if (walkthroughId !== undefined)
      sources.watch(
        state.paths
          .find((p) => p.id === walkthroughId)
          ?.steps.map((step) => step.source.file) ?? []
      );
    refresh();
    return {
      root,
      project: path.basename(root),
      revision: state.revision,
      capabilities: {
        notePresentation: true,
        onDemandSource: true,
        authoringValidation: true,
      },
      index: {
        ...sources.snapshot(walkthroughId !== undefined),
        warnings: [
          ...index.warnings,
          ...(noteUpdateWarning ? [noteUpdateWarning] : []),
        ],
      },
      focus: state.focus,
      paths: state.paths.map(({ steps, ...p }) => ({
        ...p,
        count: steps.length,
      })),
      runs: state.runs.map(({ events, ...r }) => ({
        ...r,
        count: events.length,
      })),
    };
  }
  const validId = (id: unknown): id is string =>
    typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id);
  const text = (s: unknown, max = 10000) => {
    need(
      typeof s === "string" && s.trim() && s.length <= max,
      "Text is missing or too long."
    );
    return s.trim();
  };
  // Explicit, source-reviewed content maintenance. Only a newly owned service
  // calls this; an attached host must never edit another owner's cached state.
  // The queued request is not live workspace.json and contains no credentials.
  function applyPendingNoteUpdates(): number {
    const pending = path.join(dir, "pending-note-updates.json");
    if (!fs.existsSync(pending)) return 0;
    try {
      need(
        !fs.lstatSync(pending).isSymbolicLink(),
        "Note updates must not be a symlink."
      );
      need(
        fs.statSync(pending).size <= 1024 * 1024,
        "Note updates exceed 1 MiB."
      );
      const batch = JSON.parse(fs.readFileSync(pending, "utf8")) as {
        id: string;
        updates: {
          walkthroughId: string;
          stepId: string;
          noteId: string;
          oldBody: string;
          oldHash: string;
          newBody: string;
          sourceHash: string;
          author: string;
        }[];
      };
      need(
        batch &&
          validId(batch.id) &&
          Array.isArray(batch.updates) &&
          batch.updates.length > 0 &&
          batch.updates.length <= 200,
        "Invalid note updates."
      );
      refresh();
      const before = state,
        next = structuredClone(state),
        changed = new Set<string>(),
        seen = new Set<string>();
      let applied = 0;
      for (const edit of batch.updates) {
        need(
          edit && validId(edit.noteId) && !seen.has(edit.noteId),
          "Invalid or duplicate note update."
        );
        seen.add(edit.noteId);
        const p = next.paths.find((p) => p.id === edit.walkthroughId),
          step = p?.steps.find((s) => s.id === edit.stepId),
          note = step?.notes.find((n) => n.id === edit.noteId);
        need(p && step && note, "Note update target no longer exists.");
        const body = text(edit.newBody),
          author = text(edit.author, 100);
        // A previous successful save with an interrupted archive is idempotent.
        if (
          note.body === body &&
          note.hash === edit.sourceHash &&
          note.history?.some(
            (h) => h.body === edit.oldBody && h.hash === edit.oldHash
          )
        )
          continue;
        need(
          note.body === edit.oldBody && note.hash === edit.oldHash,
          "Note changed since its replacement was reviewed."
        );
        need(
          typeof edit.sourceHash === "string" &&
            resolve(root, index, step.source).hash === edit.sourceHash,
          "Source changed since the explanation was reviewed."
        );
        need(
          note.history === undefined || Array.isArray(note.history),
          "Invalid note history."
        );
        note.history = [...(note.history ?? []), noteRevision(note)];
        note.body = body;
        note.hash = edit.sourceHash;
        note.author = author;
        note.at = new Date().toISOString();
        changed.add(p.id);
        applied++;
      }
      if (applied) {
        for (const p of next.paths) if (changed.has(p.id)) p.revision++;
        state = next;
        try {
          save();
        } catch (error) {
          state = before;
          throw error;
        }
      }
      const archive = path.join(
        dir,
        "note-updates-" + batch.id + ".applied.json"
      );
      if (fs.existsSync(archive)) {
        need(
          !fs.lstatSync(archive).isSymbolicLink() &&
            fs.readFileSync(archive, "utf8") ===
              fs.readFileSync(pending, "utf8"),
          "Note update archive already exists."
        );
        fs.unlinkSync(pending);
      } else fs.renameSync(pending, archive);
      noteUpdateWarning = null;
      return applied;
    } catch (error) {
      noteUpdateWarning =
        "Code explanations could not be updated: " + errorMessage(error);
      return 0;
    }
  }
  function commitComparisonNotes(group: ComparisonNotes) {
    const before = state;
    state = {
      ...state,
      comparisonNotes: [
        ...(state.comparisonNotes ?? []).filter(
          (item) => item.scope !== group.scope
        ),
        group,
      ],
    };
    try {
      save();
    } catch (error) {
      state = before;
      throw error;
    }
    return structuredClone(group);
  }
  function comparisonWalkthrough(id: string) {
    const saved = state.comparisonWalkthroughs?.find((walk) => walk.id === id);
    need(saved, "Comparison walkthrough not found.");
    return saved;
  }
  function commitWalkthroughNotes(
    walkthroughId: string,
    stepId: string,
    group: ComparisonNotes
  ) {
    const current = comparisonWalkthrough(walkthroughId);
    const prospective = {
      ...current,
      steps: current.steps.map((step) =>
        step.id !== stepId ? step : { ...step, annotations: group }
      ),
    };
    assertComparisonBudget(prospective);
    const before = state;
    state = {
      ...state,
      comparisonWalkthroughs: state.comparisonWalkthroughs!.map((walk) =>
        walk.id === walkthroughId ? prospective : walk
      ),
    };
    try {
      save();
    } catch (error) {
      state = before;
      throw error;
    }
    return structuredClone(group);
  }
  function commitGitViewed(
    input: { identity: string; expectedRevision: number },
    viewed: boolean
  ) {
    const result = changeGitViewed(state.gitViewed, input, viewed);
    const before = state;
    state = { ...state, gitViewed: result.records };
    try {
      save();
    } catch (error) {
      state = before;
      throw error;
    }
    return { ...result.record };
  }
  function invoke<N extends ToolName>(name: N, a: ToolArgs[N]): ToolResults[N];
  function invoke(name: string, a: Input = {}) {
    if (name === "list_git_explanations") {
      const input = a as Input & { fileId?: string; binding?: string };
      return (state.comparisonWalkthroughs ?? []).flatMap((walk) =>
        JSON.stringify(walk.query) !== JSON.stringify(input.query)
          ? []
          : walk.steps
              .filter(
                (step) =>
                  step.fileId === input.fileId && step.binding === input.binding
              )
              .map((step) => ({
                walkthroughId: walk.id,
                title: walk.title,
                stepId: step.id,
                stepTitle: step.title,
              }))
      );
    }
    if (name === "clear_git_viewed")
      return commitGitViewed(a as ToolArgs["clear_git_viewed"], false);
    if (name === "delete_walkthrough_comparison_note") {
      const input = a as ToolArgs["delete_walkthrough_comparison_note"];
      const step = comparisonStep(
        comparisonWalkthrough(input.walkthroughId),
        input.stepId
      );
      need(
        input.scope === step.annotations.scope,
        "Annotation belongs to a different authored card scope."
      );
      return commitWalkthroughNotes(
        input.walkthroughId,
        input.stepId,
        deleteComparisonNote(step.annotations, input)
      );
    }
    if (name === "delete_comparison_note") {
      const input = a as ToolArgs["delete_comparison_note"];
      return commitComparisonNotes(
        deleteComparisonNote(
          state.comparisonNotes?.find((group) => group.scope === input.scope),
          input
        )
      );
    }
    if (name === "list_comparison_walkthroughs")
      return (state.comparisonWalkthroughs ?? []).map(
        ({ id, title, steps }) => ({ id, title, count: steps.length })
      );
    if (name === "get_comparison_walkthrough") {
      const saved = state.comparisonWalkthroughs?.find(
        (walk) => walk.id === a.id
      );
      need(saved, "Comparison walkthrough not found.");
      return readComparisonWalkthrough(saved);
    }
    if (name === "project_overview") return overview(a.walkthroughId);
    refresh();
    if (name === "list_change_reviews")
      return (state.changeReviews ?? []).map(
        ({ id, title, capturedAt, fingerprint }) => ({
          id,
          title,
          capturedAt,
          fingerprint,
        })
      );
    if (name === "get_change_review") {
      const review = state.changeReviews?.find((review) => review.id === a.id);
      need(review, "Change review not found.");
      return readChangeReview(review, sources.currentText);
    }
    if (name === "create_change_review") {
      need(
        (state.changeReviews?.length ?? 0) < 20,
        "At most 20 bounded change reviews per workspace."
      );
      const review = captureChangeReview(a, sources.currentText);
      need(
        !state.changeReviews?.some((saved) => saved.id === review.id),
        "Review ID already exists; snapshots cannot be replaced."
      );
      const before = state;
      state = {
        ...state,
        changeReviews: [...(state.changeReviews ?? []), review],
      };
      try {
        save();
      } catch (error) {
        state = before;
        throw error;
      }
      return readChangeReview(review, sources.currentText);
    }
    if (name === "inspect_source") return sources.inspect(a.file!);
    if (name === "list_source_files")
      return sources.filesPage(a.query, a.cursor);
    if (name === "find_symbols") return sources.symbolsPage(a.query, a.cursor);
    if (name === "read_source") {
      need(typeof a.file === "string", "File is not indexed.");
      const content = sources.currentText(a.file),
        lines = content.split("\n"),
        start = a.startLine ?? 1,
        end = Math.min(a.endLine ?? lines.length, lines.length);
      need(
        Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 1 &&
          start <= end,
        "Invalid range."
      );
      return {
        file: a.file,
        startLine: start,
        endLine: end,
        fileHash: hash(content),
        text: lines
          .slice(start - 1, end)
          .map((l, i) => start + i + ": " + l)
          .join("\n"),
      };
    }
    if (name === "search_source")
      return sources.search(text(a.query, 500), a.cursor);
    if (name === "follow_calls")
      return follow(root, index, a.source!, a.cursor);
    if (name === "resolve_reference")
      return resolveReference(root, index, a as ToolArgs["resolve_reference"]);
    if (name === "get_walkthrough") return hydrate(get(a.id));
    if (name === "validate_walkthrough") {
      const walk = get(a.walkthroughId);
      need(
        a.expectedRevision === walk.revision,
        "Walkthrough changed. Read it again before checking authoring readiness."
      );
      return validateWalkthrough(hydrate(walk), a.notApplicable);
    }
    if (name === "source_usages")
      return buildSourceUsageIndex(root, index, state.paths).forWalkthrough(
        a.walkthroughId
      );
    if (name === "delete_walkthrough") {
      const p = get(a.id);
      need(
        a.expectedRevision === p.revision,
        "Walkthrough changed. Review it again before deleting."
      );
      const before = state;
      state = {
        ...state,
        paths: state.paths.filter((path) => path.id !== p.id),
        runs: state.runs.filter((run) => run.walkthroughId !== p.id),
        focus: state.focus?.walkthroughId === p.id ? null : state.focus,
      };
      try {
        save();
      } catch (e) {
        state = before;
        throw e;
      }
      return { id: p.id, deleted: true };
    }
    if (name === "save_walkthrough") {
      const old = a.id ? state.paths.find((p) => p.id === a.id) : null;
      if (old)
        need(
          a.expectedRevision === old.revision,
          "Path changed. Read it again and pass expectedRevision " +
            old.revision +
            "."
        );
      else
        need(
          a.expectedRevision === undefined,
          "Walkthrough no longer exists. Create a new one without expectedRevision."
        );
      need(
        Array.isArray(a.steps) && a.steps.length <= 60,
        "Provide at most 60 steps."
      );
      const id = a.id ?? crypto.randomUUID();
      need(validId(id), "Invalid path ID.");
      const ids = new Set();
      const steps: SavedStep[] = a.steps.map((s) => {
        need(validId(s.id) && !ids.has(s.id), "Invalid or duplicate step ID.");
        ids.add(s.id);
        const before = old?.steps.find((x) => x.id === s.id);
        const same =
          before &&
          before.source.file === s.source.file &&
          before.source.symbol === s.source.symbol &&
          (s.source.symbol ||
            (before.source.startLine === s.source.startLine &&
              before.source.endLine === s.source.endLine));
        const code = resolve(root, index, same ? before.source : s.source);
        const callbackRole =
          s.callbackRole === null
            ? undefined
            : (parseCallbackRole(s.callbackRole) ?? before?.callbackRole);
        const explanation = String(s.explanation ?? "").slice(0, 10000);
        const bodyChanged = before && explanation !== before.explanation;
        const sourceChanged = before && !same;
        return {
          id: s.id,
          title: text(s.title, 200),
          source: same
            ? before.source
            : {
                file: code.file,
                ...(s.source.symbol
                  ? { symbol: s.source.symbol }
                  : {
                      startLine: code.startLine,
                      endLine: code.endLine,
                      excerpt: code.excerpt,
                    }),
              },
          explanation,
          evidence: s.evidence === "source" ? "source" : "inferred",
          snapshotHash: before?.snapshotHash ?? code.hash,
          sample: s.sample ?? before?.sample,
          ...(callbackRole === undefined ? {} : { callbackRole }),
          notes: sourceChanged
            ? before.notes.map((note) => ({ ...note, reviewRequired: true }))
            : (before?.notes ?? []),
          explanationAttachments: bodyChanged
            ? undefined
            : before?.explanationAttachments,
          explanationAuthor: bodyChanged
            ? undefined
            : before?.explanationAuthor,
          explanationAt: bodyChanged ? undefined : before?.explanationAt,
          explanationHistory: bodyChanged
            ? [
                ...(before.explanationHistory ?? []),
                {
                  body: before.explanation,
                  author: before.explanationAuthor ?? "Unknown original author",
                  at: before.explanationAt ?? "",
                  hash: before.snapshotHash,
                  ...(before.explanationAttachments
                    ? { attachments: before.explanationAttachments }
                    : {}),
                },
              ]
            : before?.explanationHistory,
          explanationReviewRequired:
            bodyChanged || sourceChanged
              ? true
              : before?.explanationReviewRequired,
        };
      });
      const p = {
        id,
        title: text(a.title, 200),
        description: String(a.description ?? "").slice(0, 10000),
        steps,
        revision: (old?.revision ?? 0) + 1,
      };
      if (old) state.paths[state.paths.indexOf(old)] = p;
      else state.paths.push(p);
      save();
      return hydrate(p);
    }
    if (isAnnotationOperation(name)) {
      const original = get(a.walkthroughId);
      const result = applyAnnotationOperation(root, index, original, name, a);
      const before = state;
      state = {
        ...state,
        paths: state.paths.map((path) =>
          path.id === original.id ? result.path : path
        ),
      };
      try {
        save();
      } catch (error) {
        state = before;
        throw error;
      }
      return result.note ?? hydrate(result.path);
    }
    if (name === "add_note") {
      const p = get(a.walkthroughId),
        s = p.steps.find((s) => s.id === a.stepId);
      need(s, "Unknown step.");
      const n = {
        id: crypto.randomUUID(),
        body: text(a.body),
        author: text(a.author, 100),
        at: new Date().toISOString(),
        hash: resolve(root, index, s.source).hash,
      };
      s.notes.push(n);
      p.revision++;
      save();
      return n;
    }
    if (name === "focus_step") {
      const p = get(a.walkthroughId);
      need(
        p.steps.some((s) => s.id === a.stepId),
        "Unknown step."
      );
      state.focus = {
        walkthroughId: p.id,
        stepId: a.stepId!,
        nonce: crypto.randomUUID(),
      };
      save();
      return state.focus;
    }
    if (name === "list_runs")
      return state.runs
        .filter((r) => r.walkthroughId === a.walkthroughId)
        .map(({ events, ...r }) => ({ ...r, count: events.length }));
    if (name === "get_run") {
      const r = state.runs.find((r) => r.id === a.id);
      need(r, "Run not found.");
      return r;
    }
    if (name === "record_run") {
      const p = get(a.walkthroughId);
      need(
        ["recorded", "example"].includes(a.mode!) &&
          Array.isArray(a.events) &&
          a.events.length <= 200,
        "Invalid run."
      );
      const run = {
        id: crypto.randomUUID(),
        walkthroughId: p.id,
        label: text(a.label, 200),
        mode: a.mode!,
        origin: text(a.origin, 1000),
        at: new Date().toISOString(),
        events: a.events.map((e) => {
          need(
            p.steps.some((s) => s.id === e.stepId),
            "Unknown event step " + e.stepId
          );
          return {
            stepId: e.stepId,
            input: e.input,
            output: e.output,
            sourceHash: e.sourceHash,
            at: e.at ?? new Date().toISOString(),
          };
        }),
      };
      need(JSON.stringify(run).length < 1024 * 1024, "Run exceeds 1 MiB.");
      state.runs.unshift(run);
      state.runs = state.runs.slice(0, 50);
      p.revision++;
      save();
      return run;
    }
    throw Error("Unknown tool " + name);
  }
  return {
    root,
    dir,
    overview,
    invoke,
    applyPendingNoteUpdates,
    gitViewed(identity: string) {
      return readGitViewed(state.gitViewed, identity);
    },
    setGitViewed(identity: string, expectedRevision: number) {
      return commitGitViewed({ identity, expectedRevision }, true);
    },
    comparisonSource(walkthroughId: string, stepId: string, binding: string) {
      const saved = comparisonWalkthrough(walkthroughId);
      const step = comparisonStep(saved, stepId);
      need(step.binding === binding, "Authored source binding changed.");
      // Only immutable source identity crosses the await; commit uses CURRENT state.
      return {
        query: structuredClone(saved.query),
        fileId: step.fileId,
        binding: step.binding,
      };
    },
    saveWalkthroughComparisonNote(
      input: WalkthroughComparisonNoteInput,
      admitted: AdmittedGitFile
    ) {
      const group = saveWalkthroughNote(
        comparisonWalkthrough(input.walkthroughId),
        input,
        admitted
      );
      return commitWalkthroughNotes(input.walkthroughId, input.stepId, group);
    },
    createComparisonWalkthrough(
      input: ComparisonWalkthroughInput,
      query: GitQuery,
      views: AdmittedGitFile[]
    ) {
      const saved = authorComparisonWalkthrough(input, query, views);
      const before = state;
      state = {
        ...state,
        comparisonWalkthroughs: [
          ...(state.comparisonWalkthroughs ?? []),
          saved,
        ],
      };
      try {
        save();
      } catch (error) {
        state = before;
        throw error;
      }
      return readComparisonWalkthrough(saved);
    },
    comparisonNotes(scope: string, binding: string) {
      return readComparisonNotes(state.comparisonNotes, scope, binding);
    },
    saveComparisonNote(
      view: Omit<GitFileView, "annotations">,
      input: ComparisonNoteInput
    ) {
      commitComparisonNotes(
        saveComparisonNote(
          state.comparisonNotes?.find((group) => group.scope === view.scope),
          view,
          input
        )
      );
      return readComparisonNotes(
        state.comparisonNotes,
        view.scope,
        view.binding
      );
    },
    isNew,
    get empty() {
      return !state.paths.length;
    },
  };
}
