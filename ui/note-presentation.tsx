import type { CSSProperties, ReactNode } from "react";
import type { Note } from "../types.mjs";
import { blockLineLabel, type BlockNote } from "./block-notes";
import { MarkdownBody } from "./markdown-body";

// Shared reading presentation only. Owners supply actions and source warnings;
// this component neither decides source authority nor calls annotation APIs.
export function NoteEntry({
  note,
  block,
  revealed = false,
  warning,
  sourceError,
  children,
  id,
  data,
  style,
}: {
  note: Note;
  block?: BlockNote;
  revealed?: boolean;
  warning?: ReactNode;
  sourceError?: ReactNode;
  children?: ReactNode;
  id?: string;
  data?: Record<`data-${string}`, string | undefined>;
  style?: CSSProperties;
}) {
  return (
    <article
      {...data}
      id={id}
      className={"note" + (block ? " block-note" : "")}
      style={
        block
          ? {
              borderLeftColor: block.color,
              backgroundColor: block.tint,
              ...style,
            }
          : style
      }
      data-explanation-id={note.id}
      data-note-presentation="entry"
      aria-current={revealed ? "true" : undefined}
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
      {warning}
      <MarkdownBody body={note.body} />
      {sourceError}
      {children}
    </article>
  );
}
export type NoteTab = "notes" | "variables";
export function NoteTabButtons({
  tab,
  change,
  notes,
  ids,
}: {
  tab: string;
  change: (tab: NoteTab) => void;
  notes: readonly Note[];
  ids?: Record<NoteTab, string>;
}) {
  return (
    <>
      {(["notes", "variables"] as const).map((kind) => (
        <button
          key={kind}
          id={ids?.[kind]}
          className={tab === kind ? "active" : ""}
          aria-pressed={tab === kind}
          onClick={() => change(kind)}
        >
          {kind === "notes" ? "Notes" : "Variables"} ·{" "}
          {
            notes.filter(
              (note) =>
                !note.archived && !!note.variableName === (kind === "variables")
            ).length
          }
        </button>
      ))}
    </>
  );
}
