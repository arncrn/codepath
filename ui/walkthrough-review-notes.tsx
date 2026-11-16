import { useState } from "react";
import type { Step, Walkthrough } from "../types.mjs";
import { attachedBlockNotes } from "./block-notes";
import { NoteEntry, NoteTabButtons, type NoteTab } from "./note-presentation";
import {
  walkthroughNotePosition,
  walkthroughPurposePosition,
  type ReviewFile,
} from "./walkthrough-review-source";

export function WalkthroughReviewNotes({
  walkthrough,
  steps,
  view,
  side,
}: {
  walkthrough: Walkthrough | null;
  steps: readonly Step[];
  view: ReviewFile | null;
  side: "before" | "after";
}) {
  if (!walkthrough) return null;
  return (
    <>
      {steps.map((step) => (
        <ReviewCardNotes
          key={step.id}
          walkthrough={walkthrough}
          step={step}
          view={view}
          side={side}
        />
      ))}
    </>
  );
}
function ReviewCardNotes({
  walkthrough,
  step,
  view,
  side,
}: {
  walkthrough: Walkthrough;
  step: Step;
  view: ReviewFile | null;
  side: "before" | "after";
}) {
  const [tab, setTab] = useState<NoteTab>("notes");
  const entries = step.notes
    .filter((note) => !note.archived)
    .map((note) => ({ note, ...walkthroughNotePosition(step, note, view) }))
    .filter((entry) => entry.side === side);
  const purpose = walkthroughPurposePosition(step, view),
    blocks = attachedBlockNotes(step);
  if (!entries.length && purpose.side !== side) return null;
  return (
    <section
      className="walkthrough-review-notes"
      data-walkthrough-id={walkthrough.id}
      data-walkthrough-card={step.id}
    >
      <header>
        <small>
          {walkthrough.title} · {step.title}
        </small>
        <p>{step.source.file}</p>
      </header>
      {entries.length > 0 && (
        <div className="walkthrough-note-columns">
          <div className="detail-heading">
            <div>
              <NoteTabButtons
                tab={tab}
                change={setTab}
                notes={entries.map((entry) => entry.note)}
              />
            </div>
          </div>
          {(["notes", "variables"] as const).map((kind) => (
            <div
              key={kind}
              hidden={tab !== kind}
              className={
                kind === "variables"
                  ? "note-entries variable-entries"
                  : "note-entries"
              }
              data-note-panel={kind}
            >
              {entries
                .filter(
                  ({ note }) => !!note.variableName === (kind === "variables")
                )
                .map(({ note, status }) => (
                  <NoteEntry
                    key={note.id}
                    note={note}
                    block={
                      status === "current"
                        ? blocks.find((block) => block.id === note.id)
                        : undefined
                    }
                    data={{
                      "data-walkthrough-note-id": note.id,
                      "data-note-source-status": status,
                    }}
                    warning={
                      status !== "current" && (
                        <span className="badge warning">
                          {status === "outdated"
                            ? "Source changed · review"
                            : "Source match not verified"}
                        </span>
                      )
                    }
                  />
                ))}
              {!entries.some(
                ({ note }) => !!note.variableName === (kind === "variables")
              ) && (
                <p className="empty">
                  {kind === "variables"
                    ? "No variable explanations yet."
                    : "No notes yet."}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {purpose.side === side && step.explanation && (
        <>
          {purpose.status !== "current" && (
            <span className="badge warning">
              {purpose.status === "outdated"
                ? "Card explanation · source changed"
                : "Card explanation · source match not verified"}
            </span>
          )}
          <p className="walkthrough-purpose-body">{step.explanation}</p>
        </>
      )}
    </section>
  );
}
