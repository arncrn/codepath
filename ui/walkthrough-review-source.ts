import type { GitChangedFile, Note, Step, ToolResults } from "../types.mjs";
import {
  currentSourceAttachment,
  wholeIdentifierAttachment,
} from "../source-bindings.mjs";
export type ReviewFile = ToolResults["get_git_file"];
export type ReviewNoteStatus = "current" | "outdated" | "unverified";

// Display membership only, not relocation or source authorization.
export function walkthroughStepInFile(step: Step, file: GitChangedFile) {
  return [step.source.file, step.code?.file].some(
    (path) => !!path && (path === file.file || path === file.oldFile)
  );
}
function exact(
  step: Step,
  note: Note,
  view: ReviewFile,
  side: "before" | "after"
) {
  const code = view[side].code;
  if (!code || view[side].unavailable || note.reviewRequired) return false;
  const ranges = note.attachments ?? [];
  if (ranges.length)
    return ranges.every((range) =>
      note.variableName
        ? wholeIdentifierAttachment(range, note.variableName, code)
        : currentSourceAttachment(range, code)
    );
  return (
    !step.error &&
    !note.stale &&
    !!step.code &&
    note.hash === step.code.hash &&
    step.code.fileHash === code.fileHash &&
    step.code.file === code.file
  );
}
export function walkthroughNotePosition(
  step: Step,
  note: Note,
  view: ReviewFile | null
): { side: "before" | "after"; status: ReviewNoteStatus } {
  if (!view) return { side: "after", status: "unverified" };
  const before = exact(step, note, view, "before"),
    after = exact(step, note, view, "after");
  if (before && !after) return { side: "before", status: "current" };
  if (after) return { side: "after", status: "current" };
  return {
    side: "after",
    status:
      !view.after.code || !!view.after.unavailable || !!step.error
        ? "unverified"
        : "outdated",
  };
}
export function walkthroughPurposePosition(
  step: Step,
  view: ReviewFile | null
): { side: "before" | "after"; status: ReviewNoteStatus } {
  const side =
    view?.before.code &&
    step.code?.fileHash === view.before.code.fileHash &&
    step.code.file === view.before.code.file &&
    step.code.fileHash !== view.after.code?.fileHash
      ? "before"
      : "after";
  const target = view?.[side];
  const current =
    !!target?.code &&
    !target.unavailable &&
    !!step.code &&
    !step.error &&
    !step.stale &&
    !step.explanationReviewRequired &&
    step.snapshotHash === step.code.hash &&
    step.code.file === target.code.file &&
    step.code.fileHash === target.code.fileHash;
  return {
    side,
    status: current
      ? "current"
      : !target?.code || target.unavailable || step.error
        ? "unverified"
        : "outdated",
  };
}
