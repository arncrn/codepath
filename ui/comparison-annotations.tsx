import { useEffect, useRef, useState } from "react";
import type {
  ComparisonNotes,
  ComparisonWalkthroughStep,
  SavedComparisonStep,
  SourceAttachment,
  Step,
} from "../types.mjs";
import { errorMessage } from "../types.mjs";
import {
  saveWalkthroughComparisonNote,
  deleteWalkthroughComparisonNote,
} from "./api";
import { CodeLines } from "./source-code";
import { FunctionContextLabel } from "./function-context";
import { NoteEntry, NoteTabButtons } from "./note-presentation";
import type { tokenizeSource } from "./source-syntax";
import {
  attachedBlockNotes,
  wholeLineBlock,
  blockLineLabel,
} from "./block-notes";
import { DeleteNoteAction } from "./delete-note";

export interface ComparisonDraft {
  instance: symbol;
  body: string;
  variableName: string;
  attachments: SourceAttachment[];
  expectedRevision: number;
  version: number;
}
export type ComparisonDrafts = Record<string, ComparisonDraft>;
export interface ComparisonAnnotationContext {
  view: ComparisonWalkthroughStep;
  side: "before" | "after";
  walkthroughId: string;
  authored: SavedComparisonStep["before"];
  drafts: ComparisonDrafts;
  editDraft: (key: string, draft: ComparisonDraft) => void;
  clearSubmittedDraft: (key: string, submitted: ComparisonDraft) => void;
  saved: (
    view: ComparisonWalkthroughStep,
    annotations: ComparisonNotes
  ) => void;
  current: () => boolean;
  lifetime: symbol;
  surface?: "saved";
}

export function ComparisonAnnotations({
  view,
  side,
  walkthroughId,
  authored,
  changedLines,
  syntax,
  rowLines,
  plainDiff,
  drafts,
  editDraft,
  clearSubmittedDraft,
  saved,
  current,
  lifetime: presentation,
  surface,
}: ComparisonAnnotationContext & {
  changedLines: Set<number>;
  syntax: ReturnType<typeof tokenizeSource>;
  rowLines: readonly (number | null)[];
  plainDiff: boolean;
}) {
  const annotation = useComparisonAnnotations({
    view,
    side,
    walkthroughId,
    authored,
    drafts,
    editDraft,
    clearSubmittedDraft,
    saved,
    current,
    lifetime: presentation,
    surface,
  });
  const source = view[side];
  return (
    <section className="review-side" data-git-side={side}>
      <header className="comparison-card-heading">
        <h3>{authored.title}</h3>
        <p className="authored-version">
          {side === "before" ? "Before" : "After"} · {source.label}
        </p>
        <p className="git-source-path">
          {source.file}
          {source.mode === "000000" ? " · absent" : ""}
        </p>
      </header>
      <div className="comparison-card-body">
        {plainDiff && (
          <p className="plain-diff">
            Plain source — diff alignment unavailable for these raw source
            bytes.
          </p>
        )}
        {source.unavailable ? (
          <p>{source.unavailable}</p>
        ) : source.content === "" ? (
          <p>
            {source.mode === "000000"
              ? "No file on this side."
              : "Empty file on this side."}
          </p>
        ) : (
          <div className="code review-source">
            <FunctionContextLabel step={annotation.step!} />
            <CodeLines
              step={annotation.step!}
              walkthroughId=""
              full={false}
              exact
              snapshot
              syntax={syntax}
              changedLines={changedLines}
              rowLines={rowLines}
              changeKind={side === "before" ? "removed" : "added"}
              explanationColors={annotation.colors}
              selectRange={annotation.selectRange}
              reveal={annotation.reveal}
            />
            {source.code?.excerpt === "" && <p>Blank source excerpt.</p>}
          </div>
        )}
        {annotation.content}
      </div>
    </section>
  );
}

// The current full-file and explicit saved-excerpt adapters share annotation behavior.
export function useComparisonAnnotations(
  context: ComparisonAnnotationContext | null
) {
  const identity = context
    ? JSON.stringify([
        context.walkthroughId,
        context.view.id,
        context.view.annotations.scope,
        context.view.binding,
        context.side,
        context.surface ?? "current",
      ])
    : "";
  const owner = useRef({
    identity,
    presentation: context?.lifetime,
    instance: Symbol("annotation lifetime"),
    version: 0,
  });
  if (
    owner.current.identity !== identity ||
    owner.current.presentation !== context?.lifetime
  )
    owner.current = {
      identity,
      presentation: context?.lifetime,
      instance: Symbol("annotation lifetime"),
      version: 0,
    };
  const lifetime = owner.current;
  useEffect(
    () => () => {
      owner.current = {
        identity: "",
        presentation: undefined,
        instance: Symbol("unmounted annotation"),
        version: 0,
      };
    },
    []
  );
  const current = () => owner.current === lifetime && !!context?.current();
  const action = () => {
    lifetime.version++;
  };
  const [state, setState] = useState({
    instance: lifetime.instance,
    tab: "notes" as "notes" | "variables",
    editor: null as string | null,
    selection: null as SourceAttachment | null,
    error: "",
    busy: false,
  });
  if (state.instance !== lifetime.instance)
    setState({
      instance: lifetime.instance,
      tab: "notes",
      editor: null,
      selection: null,
      error: "",
      busy: false,
    });
  const { tab, editor, selection, error, busy } = state;
  const setTab = (tab: "notes" | "variables") =>
    setState((s) => ({ ...s, tab }));
  const setEditor = (editor: string | null) =>
    setState((s) => ({ ...s, editor }));
  const setSelection = (selection: SourceAttachment | null) =>
    setState((s) => ({ ...s, selection }));
  const setError = (error: string) => setState((s) => ({ ...s, error }));
  const setBusy = (busy: boolean) => setState((s) => ({ ...s, busy }));
  if (!context)
    return {
      step: undefined,
      colors: {},
      selectRange: undefined,
      reveal: undefined,
      content: null,
    };
  const {
    view,
    side,
    walkthroughId,
    authored,
    drafts,
    editDraft,
    clearSubmittedDraft,
    saved,
  } = context;
  const source = view[side];
  const colors = Object.fromEntries(
    view.annotations.notes
      .filter((note) => note.side === side && note.variableName)
      .map((note, index) => [
        note.id,
        `hsl(${[174, 42, 260, 210][index % 4]} 65% 58%)`,
      ])
  );
  const notes = view.annotations.notes
    .filter((note) => note.side === side)
    .map((note) => ({ ...note, stale: note.binding !== view.binding }));
  const step: Step = {
    id: view.id + side,
    title: side,
    source: { file: source.file },
    explanation: "",
    evidence: "source",
    snapshotHash: source.code?.hash ?? "",
    code: source.code,
    notes,
    stale: false,
  };
  const blocks = attachedBlockNotes(step);
  const keyFor = (id: string) =>
    JSON.stringify([
      walkthroughId,
      view.id,
      view.annotations.scope,
      view.binding,
      side,
      id,
    ]);
  const key = keyFor(editor ?? "new");
  const draft = drafts[key];
  function open(id: string, attachments?: SourceAttachment[]) {
    if (!current()) return;
    action();
    setBusy(false);
    setEditor(id);
    setError("");
    const note = notes.find((note) => note.id === id);
    if (!drafts[keyFor(id)])
      editDraft(keyFor(id), {
        instance: Symbol("comparison draft"),
        body: note?.body ?? "",
        variableName: note?.variableName ?? "",
        attachments: attachments ?? note?.attachments ?? [],
        expectedRevision: view.annotations.revision,
        version: 0,
      });
  }
  function update(patch: Partial<ComparisonDraft>) {
    if (!current()) return;
    action();
    setBusy(false);
    if (draft)
      editDraft(key, { ...draft, ...patch, version: draft.version + 1 });
  }
  const noteId = (id: string) =>
    "comparison-note-" + encodeURIComponent(identity) + "-" + id;
  return {
    step,
    colors,
    selectRange: (range: SourceAttachment | null) => {
      if (current()) setSelection(range);
    },
    reveal: (ids: string[]) => {
      if (!current()) return;
      action();
      const version = lifetime.version;
      setTab("variables");
      requestAnimationFrame(() => {
        if (current() && lifetime.version === version)
          document
            .getElementById(noteId(ids[0]))
            ?.scrollIntoView({ block: "nearest" });
      });
    },
    content: (
      <>
        {selection && (
          <div>
            <span>
              Selected {selection.startLine}:{selection.startColumn}–
              {selection.endLine}:{selection.endColumn}
            </span>
            <button
              disabled={!source.code}
              onClick={() => {
                const range = wholeLineBlock(step, selection);
                if (range) {
                  setTab("notes");
                  open(
                    "new-block-" +
                      selection.startLine +
                      "-" +
                      selection.endLine,
                    [range]
                  );
                }
              }}
            >
              Create note
            </button>
            <button
              disabled={!source.code}
              onClick={() => {
                setTab("variables");
                open(
                  "new-variable-" +
                    selection.startLine +
                    "-" +
                    selection.startColumn,
                  [selection]
                );
              }}
            >
              Explain selected variable
            </button>
          </div>
        )}
        {context.surface !== "saved" && <h3>{authored.title}</h3>}
        <div className="authored-purpose">
          <small>PURPOSE</small>
          <p>{authored.purpose}</p>
        </div>
        <div className="detail-heading">
          <div>
            <NoteTabButtons tab={tab} change={setTab} notes={notes} />
          </div>
          <button
            disabled={!source.code}
            onClick={() => open(tab === "variables" ? "new-variable" : "new")}
          >
            {tab === "variables" ? "Write variable explanation" : "Write note"}
          </button>
        </div>
        {editor && draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!current()) return;
              action();
              const submitted = draft,
                submittedKey = key,
                token = lifetime.version;
              setBusy(true);
              setError("");
              const existing = notes.find((note) => note.id === editor);
              void saveWalkthroughComparisonNote({
                walkthroughId,
                stepId: view.id,
                binding: view.binding,
                side,
                expectedRevision: submitted.expectedRevision,
                ...(existing ? { noteId: existing.id } : {}),
                body: submitted.body,
                author: "You",
                attachments: submitted.attachments,
                ...(submitted.variableName
                  ? { variableName: submitted.variableName }
                  : {}),
              })
                .then((annotations) => {
                  if (current()) saved(view, annotations);
                  // Neither a later edit nor a recreated draft belongs to this save.
                  clearSubmittedDraft(submittedKey, submitted);
                  if (current() && token === lifetime.version) setEditor(null);
                })
                .catch((error: unknown) => {
                  if (current() && token === lifetime.version)
                    setError(errorMessage(error));
                })
                .finally(() => {
                  if (current() && token === lifetime.version) setBusy(false);
                });
            }}
          >
            <label>
              Note text
              <textarea
                aria-label="Note text"
                required
                value={draft.body}
                onChange={(event) => update({ body: event.target.value })}
              />
            </label>
            {(tab === "variables" ||
              draft.variableName ||
              editor.includes("variable")) && (
              <label>
                Variable name
                <input
                  aria-label="Variable name"
                  required
                  value={draft.variableName}
                  onChange={(event) =>
                    update({ variableName: event.target.value })
                  }
                />
              </label>
            )}
            <p>
              {draft.attachments.length
                ? blockLineLabel(draft.attachments)
                : "Plain note (no source highlighting)"}
            </p>
            {draft.expectedRevision !== view.annotations.revision && (
              <div className="edit-conflict">
                <p>
                  Notes changed while this draft was open. Read the saved
                  entries below before retrying.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    update({ expectedRevision: view.annotations.revision })
                  }
                >
                  Use latest notes revision
                </button>
              </div>
            )}
            {error && <p role="alert">{error}</p>}
            <button disabled={busy} type="submit">
              Save note
            </button>
            <button
              type="button"
              onClick={() => {
                action();
                setBusy(false);
                setEditor(null);
              }}
            >
              Close editor
            </button>
          </form>
        )}
        {authored.notApplicable?.[tab] && (
          <p className="not-applicable">
            {tab === "notes" ? "Notes" : "Variables"} not applicable:{" "}
            {authored.notApplicable[tab]}
          </p>
        )}
        <div
          className={
            "review-notes note-entries" +
            (tab === "variables" ? " variable-entries" : "")
          }
        >
          {notes
            .filter(
              (note) =>
                !note.archived && !!note.variableName === (tab === "variables")
            )
            .map((note) => {
              const block = blocks.find((block) => block.id === note.id);
              return (
                <NoteEntry
                  note={note}
                  block={block}
                  id={noteId(note.id)}
                  key={note.id}
                  style={
                    !block && note.variableName
                      ? {
                          borderLeftColor: colors[note.id],
                          borderLeftStyle: "solid",
                          borderLeftWidth: 3,
                        }
                      : undefined
                  }
                  warning={
                    note.stale && (
                      <span className="badge warning">
                        From an earlier comparison · source changed
                      </span>
                    )
                  }
                >
                  <button
                    disabled={note.stale || !source.code}
                    onClick={() => open(note.id)}
                  >
                    Edit
                  </button>
                  <DeleteNoteAction
                    current={current}
                    remove={async () => {
                      if (!current()) return;
                      const annotations = await deleteWalkthroughComparisonNote(
                        {
                          walkthroughId,
                          stepId: view.id,
                          scope: view.annotations.scope,
                          noteId: note.id,
                          expectedRevision: view.annotations.revision,
                        }
                      );
                      if (current()) saved(view, annotations);
                    }}
                  />
                </NoteEntry>
              );
            })}
        </div>
      </>
    ),
  };
}
