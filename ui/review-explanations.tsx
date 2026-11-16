import { useState } from "react";
import type { ComparisonWalkthroughStep, GitQuery } from "../types.mjs";
import { NoteEntry, NoteTabButtons, type NoteTab } from "./note-presentation";
import type {
  ComparisonDrafts,
  ComparisonAnnotationContext,
} from "./comparison-annotations";
import { DeleteNoteAction } from "./delete-note";
import { deleteWalkthroughComparisonNote } from "./api";
import { MarkdownBody } from "./markdown-body";

export function queryLabel(query: GitQuery) {
  return query.mode === "changes"
    ? "staged / unstaged changes"
    : `${query.base} → ${query.target === "WORKING_TREE" ? "Working tree (saved)" : query.target}`;
}

export function ReadonlyExplanation({
  step,
  side,
  status,
  query,
  walkthroughId,
  drafts,
  context,
}: {
  step: ComparisonWalkthroughStep;
  side: "before" | "after";
  status: "outdated" | "unverified" | "current";
  query: GitQuery;
  walkthroughId: string;
  drafts: ComparisonDrafts;
  context: ComparisonAnnotationContext;
}) {
  const [tab, setTab] = useState<NoteTab>("notes");
  const source = step[side],
    notes = step.annotations.notes.filter(
      (note) => note.side === side && !note.archived
    );
  const prefix = [
    walkthroughId,
    step.id,
    step.annotations.scope,
    step.binding,
    side,
  ];
  const retained = Object.entries(drafts).filter(([key]) => {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) && prefix.every((part, i) => parts[i] === part);
  });
  return (
    <section
      className="readonly-explanation"
      data-inline-explanation={step.id}
      data-explanation-status={status}
    >
      <header>
        <h3>{source.title}</h3>
        <p className="explanation-status">
          {status === "outdated"
            ? "Out of date for this comparison"
            : status === "unverified"
              ? "Source match not verified"
              : "Additional explanation for these exact source versions"}
        </p>
        <p className="original-explanation-source">
          Written for {queryLabel(query)} ·{" "}
          {side === "before" ? "Before" : "After"}: {source.label} ·{" "}
          {source.file}
          {source.startLine > 0
            ? ` · original lines ${source.startLine}–${source.endLine}`
            : " · no file on this side"}
        </p>
      </header>
      <div className="explanation-purpose">
        <small>PURPOSE</small>
        <MarkdownBody body={source.purpose} />
      </div>
      <div className="detail-heading">
        <div>
          <NoteTabButtons tab={tab} change={setTab} notes={notes} />
        </div>
      </div>
      {(["notes", "variables"] as const).map((kind) => {
        const entries = notes.filter((note) =>
          kind === "variables" ? !!note.variableName : !note.variableName
        );
        return (
          <section
            key={kind}
            className={
              "readonly-note-group note-entries" +
              (kind === "variables" ? " variable-entries" : "")
            }
            hidden={tab !== kind}
            data-note-panel={kind}
            aria-label={kind === "notes" ? "Notes" : "Variables"}
          >
            {entries.map((note) => (
              <NoteEntry
                note={note}
                key={note.id}
                data={{ "data-visible-note": note.id }}
              >
                {note.binding !== step.binding && (
                  <small>Out of date for the original authored source</small>
                )}
                <DeleteNoteAction
                  current={context.current}
                  remove={async () => {
                    if (!context.current()) return;
                    const annotations = await deleteWalkthroughComparisonNote({
                      walkthroughId,
                      stepId: step.id,
                      scope: step.annotations.scope,
                      noteId: note.id,
                      expectedRevision: step.annotations.revision,
                    });
                    if (context.current()) context.saved(step, annotations);
                  }}
                />
                {(note.attachments?.length ?? 0) > 0 && (
                  <small>
                    Original source:{" "}
                    {(note.attachments ?? [])
                      .map((a) => `lines ${a.startLine}–${a.endLine}`)
                      .join(", ")}
                  </small>
                )}
              </NoteEntry>
            ))}
            {entries.length === 0 && (
              <p>
                {source.notApplicable?.[kind] ??
                  (kind === "notes"
                    ? "No notes have been written."
                    : "No variable explanations have been written.")}
              </p>
            )}
          </section>
        );
      })}
      {retained.map(([key, draft]) => (
        <label key={key}>
          Unsaved draft kept for its original source versions
          <textarea
            aria-label="Retained original-source draft"
            readOnly
            value={draft.body}
          />
        </label>
      ))}
    </section>
  );
}
