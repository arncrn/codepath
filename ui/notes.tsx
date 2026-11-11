import { useRef, useState } from "react";
import type { SubmitEvent } from "react";
import type { Note, ReferenceContext, Step } from "../types.mjs";
import type { useAnnotationEditor } from "./annotation-editor";
import { attachedBlockNotes, blockLineLabel } from "./block-notes";
import { addNote } from "./api";
import { MarkdownBody } from "./markdown-body";
import type { ReadingContext } from "./reading-context";

export function useNoteDraft(fail: (error: unknown) => void) {
  const [body, setBody] = useState("");
  const editVersion = useRef(0);
  function edit(body: string) {
    editVersion.current++;
    setBody(body);
  }
  function reset() {
    setBody("");
  }
  async function submit(
    event: SubmitEvent<HTMLFormElement>,
    target: Pick<ReferenceContext, "walkthroughId" | "stepId"> | null,
    refresh: () => Promise<void>
  ) {
    event.preventDefault();
    if (!target) return;
    const submittedVersion = editVersion.current;
    try {
      await addNote({ ...target, body, author: "You" });
      if (submittedVersion === editVersion.current) setBody("");
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  return { body, edit, reset, submit };
}

export function NotesPanel({
  currentStep,
  tab,
  draft,
  target,
  refresh,
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
}) {
  const blocks = currentStep ? attachedBlockNotes(currentStep) : [];
  function noteEntry(note: Note) {
    const block = blocks.find((block) => block.id === note.id);
    return (
      <article
        className={"note" + (block ? " block-note" : "")}
        style={
          block
            ? { borderLeftColor: block.color, backgroundColor: block.tint }
            : undefined
        }
        key={note.id}
        data-explanation-id={note.id}
        aria-current={revealedIds.includes(note.id) ? "true" : undefined}
      >
        {block && (
          <small className="block-note-location">
            {blockLineLabel(block.ranges)}
          </small>
        )}
        {note.variableName && (
          <h3>
            <code>{note.variableName}</code>
            {note.attachments?.[0] && (
              <small className="variable-location">
                Line {note.attachments[0].startLine}
              </small>
            )}
          </h3>
        )}
        {(note.stale || currentStep?.error) && (
          <span className="badge warning">
            {currentStep?.error
              ? "Source unavailable · review"
              : note.hash !== currentStep?.code?.hash
                ? "Source changed · review"
                : "Note needs review"}
          </span>
        )}
        <MarkdownBody body={note.body} />
        {note.attachments?.some(
          (range) => range.fileHash !== currentStep?.code?.fileHash
        ) && (
          <p className="source-error">
            Attachments need source review. Select their ranges again.
          </p>
        )}
        <button
          disabled={!currentStep?.code}
          onClick={() => review.open(note.id)}
        >
          Edit
        </button>
      </article>
    );
  }
  function entries(variable: boolean) {
    const notes =
      currentStep?.notes.filter(
        (note) => !note.archived && !!note.variableName === variable
      ) ?? [];
    return (
      <div id={variable ? "variables" : "notes"}>
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
