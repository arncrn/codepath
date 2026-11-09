import { useId, useState } from "react";
import type { NoteReview, SourceAttachment, Step } from "../types.mjs";
import { addReviewedNote, reviewExplanation, reviewNote } from "./api";
import { blockLineLabel, wholeLineBlock } from "./block-notes";

type DraftSource = { step: Step; walkthroughId: string; revision: number };

type ReviewDraft = NoteReview & { targetId: string; version: number };
type Panel = "notes" | "variables";
export function useAnnotationEditor({
  step,
  walkthroughId,
  revision,
  selectedRange,
  refresh,
  fail,
  clearError,
}: {
  step?: Step;
  walkthroughId?: string;
  revision?: number;
  selectedRange?: SourceAttachment;
  refresh: () => Promise<void>;
  fail: (error: unknown) => void;
  clearError: () => void;
}) {
  // Drafts belong to a target, not a polled Step object or the visible tab.
  const [drafts, setDrafts] = useState<Partial<Record<string, ReviewDraft>>>(
    {}
  );
  const [active, setActive] = useState<Partial<Record<Panel, string>>>({});
  const [pending, setPending] = useState(false);
  const bodyId = useId();
  function openDraft(
    targetId: string,
    { step, walkthroughId, revision }: DraftSource,
    attachments?: SourceAttachment[]
  ) {
    if (!step.code) return;
    clearError();
    const note = step.notes.find((note) => note.id === targetId);
    const panel: Panel =
      targetId === "new-variable" || note?.variableName ? "variables" : "notes";
    const key = JSON.stringify([walkthroughId, step.id, targetId]);
    setDrafts((current) =>
      current[key]
        ? current
        : {
            ...current,
            [key]: {
              walkthroughId,
              stepId: step.id,
              expectedRevision: revision,
              sourceHash: step.code!.hash,
              fileHash: step.code!.fileHash,
              body:
                targetId === "explanation"
                  ? step.explanation
                  : (note?.body ?? ""),
              author: "You",
              attachments:
                targetId === "explanation"
                  ? (step.explanationAttachments ?? [])
                  : (attachments ?? note?.attachments ?? []),
              ...(targetId === "explanation"
                ? {}
                : {
                    variableName:
                      targetId === "new-variable"
                        ? ""
                        : (note?.variableName ?? null),
                    archived: note?.archived ?? false,
                  }),
              targetId,
              version: 0,
            },
          }
    );
    setActive((current) => ({ ...current, [panel]: key }));
  }
  function open(targetId: string) {
    if (step && walkthroughId && revision !== undefined)
      openDraft(targetId, { step, walkthroughId, revision });
  }
  function createBlock(
    source: DraftSource,
    selection: SourceAttachment
  ): boolean {
    const block = wholeLineBlock(source.step, selection);
    if (!block) {
      fail(
        Error(
          "The selected code changed. Select the block again before creating a note."
        )
      );
      return false;
    }
    // Different selections keep independent drafts; reselecting the same lines
    // reopens that draft without replacing its text or silently refreshing it.
    openDraft(
      "new-block:" +
        JSON.stringify([block.file, block.startLine, block.endLine]),
      source,
      [block]
    );
    return true;
  }
  function editor(panel: Panel) {
    const key = active[panel];
    const draft = key ? drafts[key] : undefined;
    if (
      !key ||
      !draft ||
      draft.walkthroughId !== walkthroughId ||
      draft.stepId !== step?.id
    )
      return null;
    const isCard = draft.targetId === "explanation";
    const isBlockCreation = draft.targetId.startsWith("new-block:");
    const blockSourceChanged =
      isBlockCreation && draft.fileHash !== step?.code?.fileHash;
    const replacementBlock =
      selectedRange && step ? wholeLineBlock(step, selectedRange) : null;
    const isVariable =
      draft.variableName !== null && draft.variableName !== undefined;
    function change(update: Partial<ReviewDraft>) {
      setDrafts((current) => {
        const existing = current[key!];
        if (!existing) return current;
        return {
          ...current,
          [key!]: { ...existing, ...update, version: existing.version + 1 },
        };
      });
    }
    return (
      <form
        key={key}
        className="form annotation-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          clearError();
          if (
            isVariable &&
            (!draft.variableName?.trim() ||
              !draft.attachments.length ||
              draft.attachments.some(
                (range) => range.text !== draft.variableName
              ))
          ) {
            fail(
              Error(
                "A variable explanation needs a name and at least one source attachment. Every attachment must select exactly that name."
              )
            );
            return;
          }
          const submitted = draft;
          setPending(true);
          try {
            const { targetId, version, ...review } = submitted;
            if (targetId === "explanation") await reviewExplanation(review);
            else if (
              targetId === "new-block" ||
              targetId === "new-variable" ||
              targetId.startsWith("new-block:")
            )
              await addReviewedNote(review);
            else await reviewNote({ ...review, noteId: targetId });
            setDrafts((current) => {
              if (current[key]?.version !== version) return current;
              const next = { ...current };
              delete next[key];
              return next;
            });
            await refresh();
          } catch (error) {
            fail(error);
          } finally {
            setPending(false);
          }
        }}
      >
        <h3>
          {isBlockCreation
            ? "Create note"
            : isCard
              ? "Correct or re-review card explanation"
              : "Write or review note"}
        </h3>
        {isBlockCreation && <small>{blockLineLabel(draft.attachments)}</small>}
        {!isCard && !isBlockCreation && (
          <fieldset>
            <legend>Note presentation</legend>
            <label>
              Classification
              <select
                aria-label="Classification"
                value={isVariable ? "variable" : "block"}
                onChange={(event) =>
                  change({
                    variableName: event.target.value === "variable" ? "" : null,
                  })
                }
              >
                <option value="block">Block note (Notes)</option>
                <option value="variable">
                  Named variable explanation (Variables)
                </option>
              </select>
            </label>
            {isVariable && (
              <label>
                Variable name
                <input
                  required
                  value={draft.variableName ?? ""}
                  onChange={(event) =>
                    change({ variableName: event.target.value })
                  }
                />
              </label>
            )}
          </fieldset>
        )}
        <label htmlFor={bodyId + panel}>
          {isBlockCreation ? "Note" : "Reviewed explanation"}
        </label>
        <textarea
          id={bodyId + panel}
          autoFocus={isBlockCreation}
          required
          value={draft.body}
          onChange={(event) => change({ body: event.target.value })}
        />
        {(draft.expectedRevision !== revision ||
          draft.sourceHash !== step?.code?.hash ||
          draft.fileHash !== step?.code?.fileHash) && (
          <section className="edit-conflict">
            <p>
              This walkthrough changed while you were editing. Check the current
              code and saved explanation before continuing.
            </p>
            {!draft.targetId.startsWith("new-") && (
              <blockquote>
                {isCard
                  ? step?.explanation
                  : step?.notes.find((note) => note.id === draft.targetId)
                      ?.body}
              </blockquote>
            )}
            {blockSourceChanged && (
              <p>
                Select the block again to keep your draft with the current code.
              </p>
            )}
            <button
              type="button"
              disabled={blockSourceChanged && !replacementBlock}
              onClick={() => {
                if (step?.code && revision !== undefined)
                  change({
                    expectedRevision: revision,
                    sourceHash: step.code.hash,
                    fileHash: step.code.fileHash,
                    ...(blockSourceChanged && replacementBlock
                      ? { attachments: [replacementBlock] }
                      : {}),
                  });
              }}
            >
              {blockSourceChanged ? "Use selected block" : "Use my edit"}
            </button>
          </section>
        )}
        {!isBlockCreation && (
          <fieldset>
            <legend>Explicit source attachments</legend>
            <p>
              Select text within highlighted source, then add it here. Columns
              start at zero; the end is exclusive.
              {isVariable &&
                " Every range must select exactly the variable name; no implicit same-name binding."}
            </p>
            <button
              type="button"
              disabled={
                !selectedRange || selectedRange.fileHash !== draft.fileHash
              }
              onClick={() => {
                if (selectedRange)
                  change({
                    attachments: [...draft.attachments, selectedRange],
                  });
              }}
            >
              Attach selected source range
            </button>
            <ul>
              {draft.attachments.map((range, index) => (
                <li key={index}>
                  {range.file} {range.startLine}:{range.startColumn} to{" "}
                  {range.endLine}:{range.endColumn} <code>{range.text}</code>
                  {range.fileHash !== step?.code?.fileHash && (
                    <strong> Source changed. Remove and select again.</strong>
                  )}
                  <button
                    type="button"
                    aria-label={"Remove attachment " + (index + 1)}
                    onClick={() =>
                      change({
                        attachments: draft.attachments.filter(
                          (_, position) => position !== index
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <button className="primary" disabled={pending || !step?.code}>
          {isBlockCreation ? "Save note" : "Save reviewed explanation"}
        </button>
        <button
          type="button"
          onClick={() => setActive((current) => ({ ...current, [panel]: "" }))}
        >
          Keep draft and close
        </button>
      </form>
    );
  }
  return { open, createBlock, editor };
}
