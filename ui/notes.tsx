import { useRef, useState } from "react";
import type { SubmitEvent } from "react";
import type { Note, ReferenceContext, Step } from "../types.mjs";
import type { useAnnotationEditor } from "./annotation-editor";
import { attachedBlockNotes } from "./block-notes";
import { addNote, deleteNote } from "./api";
import { NoteEntry } from "./note-presentation";
import { DeleteNoteAction } from "./delete-note";
import type { ReadingContext } from "./reading-context";

export function useNoteDraft(fail: (error: unknown) => void) {
  const [body, setBody] = useState("");
  const scope = useRef<string | null>(null);
  const drafts = useRef(new Map<string, { body: string; version: number }>());
  function switchScope(key: string | null) {
    scope.current = key;
    setBody(key ? (drafts.current.get(key)?.body ?? "") : "");
  }
  function edit(body: string) {
    const key = scope.current;
    if (key)
      drafts.current.set(key, {
        body,
        version: (drafts.current.get(key)?.version ?? 0) + 1,
      });
    setBody(body);
  }
  function reset() {
    edit("");
  }
  async function submit(
    event: SubmitEvent<HTMLFormElement>,
    target: Pick<ReferenceContext, "walkthroughId" | "stepId"> | null,
    refresh: () => Promise<void>
  ) {
    event.preventDefault();
    if (!target) return;
    const submittedScope = scope.current;
    const submittedVersion = submittedScope
      ? drafts.current.get(submittedScope)?.version
      : undefined;
    try {
      await addNote({ ...target, body, author: "You" });
      if (
        submittedScope &&
        drafts.current.get(submittedScope)?.version === submittedVersion
      ) {
        drafts.current.set(submittedScope, {
          body: "",
          version: (submittedVersion ?? 0) + 1,
        });
        if (scope.current === submittedScope) setBody("");
      }
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  return { body, edit, reset, switchScope, submit };
}

export function NotesPanel({
  currentStep,
  tab,
  draft,
  target,
  refresh,
  revision,
  review,
  revealedIds,
}: {
  review: ReturnType<typeof useAnnotationEditor>;
  revealedIds: string[];
  currentStep: Step | undefined;
  tab: ReadingContext["tab"];
  draft: ReturnType<typeof useNoteDraft>;
  target: Pick<ReferenceContext, "walkthroughId" | "stepId"> | null;
  refresh: () => Promise<void>;
  revision: number | undefined;
}) {
  const blocks = currentStep ? attachedBlockNotes(currentStep) : [];
  function noteEntry(note: Note) {
    const block = blocks.find((block) => block.id === note.id);
    return (
      <NoteEntry
        note={note}
        block={block}
        key={note.id}
        revealed={revealedIds.includes(note.id)}
        warning={
          (note.stale || currentStep?.error) && (
            <span className="badge warning">
              {currentStep?.error
                ? "Source unavailable · review"
                : note.hash !== currentStep?.code?.hash
                  ? "Source changed · review"
                  : "Note needs review"}
            </span>
          )
        }
        sourceError={
          note.attachments?.some(
            (range) => range.fileHash !== currentStep?.code?.fileHash
          ) && (
            <p className="source-error">
              Attachments need source review. Select their ranges again.
            </p>
          )
        }
      >
        <button
          disabled={!currentStep?.code}
          onClick={() => review.open(note.id)}
        >
          Edit
        </button>
        {target && revision !== undefined && (
          <DeleteNoteAction
            key={target.walkthroughId + currentStep?.id + note.id}
            remove={async () => {
              await deleteNote({
                ...target,
                noteId: note.id,
                expectedRevision: revision,
              });
              await refresh();
            }}
          />
        )}
      </NoteEntry>
    );
  }
  function entries(variable: boolean) {
    const notes =
      currentStep?.notes.filter(
        (note) => !note.archived && !!note.variableName === variable
      ) ?? [];
    return (
      <div
        id={variable ? "variables" : "notes"}
        className={variable ? "note-entries variable-entries" : "note-entries"}
      >
        {notes.length ? (
          notes.map(noteEntry)
        ) : (
          <p className="empty">
            {variable ? "No variable explanations yet." : "No notes yet."}
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      <div id="notes-panel" hidden={tab !== "notes"}>
        <div className="note-review-controls">
          <button
            disabled={!currentStep?.code}
            onClick={() => review.open("explanation")}
          >
            Edit card explanation
          </button>
          <button
            disabled={!currentStep?.code}
            onClick={() => review.open("new-block")}
          >
            Write attached note
          </button>
          {review.editor("notes")}
        </div>
        <div>{entries(false)}</div>
        <form
          id="note-form"
          onSubmit={(event) => void draft.submit(event, target, refresh)}
        >
          <label htmlFor="note-text">Add a note</label>
          <textarea
            id="note-text"
            placeholder="Explain a code block or a function call."
            required
            value={draft.body}
            onChange={(event) => draft.edit(event.target.value)}
          />
          <div>
            <button className="primary">Save note</button>
          </div>
        </form>
      </div>
      <div id="variables-panel" hidden={tab !== "variables"}>
        <button
          disabled={!currentStep?.code}
          onClick={() => review.open("new-variable")}
        >
          Write variable explanation
        </button>
        {review.editor("variables")}
        {entries(true)}
      </div>
    </>
  );
}
