import type {
  AuthoringNotApplicable,
  AuthoringReport,
  Walkthrough,
} from "./types.mjs";
import {
  currentSourceAttachment,
  wholeIdentifierAttachment,
} from "./source-bindings.mjs";

// Read-only authoring feedback, not a new persistence format or a writing gate.
export function validateWalkthrough(
  walk: Walkthrough,
  input: unknown = []
): AuthoringReport {
  if (!Array.isArray(input) || input.length > 60)
    throw Error("Invalid not-applicable reasons.");
  const seen = new Set<string>();
  const notApplicable: AuthoringNotApplicable[] = input.map(
    (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error("Invalid not-applicable reason.");
      const fields: Record<string, unknown> = Object.fromEntries(
        Object.entries(value)
      );
      if (
        Object.keys(fields).some(
          (key) =>
            ![
              "stepId",
              "sourceHash",
              "fileHash",
              "notes",
              "variables",
            ].includes(key)
        ) ||
        typeof fields.stepId !== "string" ||
        seen.has(fields.stepId)
      )
        throw Error("Invalid or duplicate not-applicable reason.");
      seen.add(fields.stepId);
      const step = walk.steps.find((step) => step.id === fields.stepId);
      if (!step) throw Error("Unknown card in not-applicable reasons.");
      if (
        !step.code ||
        step.error ||
        typeof fields.sourceHash !== "string" ||
        typeof fields.fileHash !== "string" ||
        fields.sourceHash !== step.code.hash ||
        fields.fileHash !== step.code.fileHash
      )
        throw Error(
          "Source changed. Read current source before supplying not-applicable reasons."
        );
      const result: AuthoringNotApplicable = {
        stepId: step.id,
        sourceHash: fields.sourceHash,
        fileHash: fields.fileHash,
      };
      for (const category of ["notes", "variables"] as const) {
        const reason = fields[category];
        if (reason !== undefined) {
          if (
            typeof reason !== "string" ||
            !reason.trim() ||
            reason.length > 1000
          )
            throw Error(
              "Provide a nonempty not-applicable reason, at most 1,000 characters."
            );
          result[category] = reason.trim();
        }
      }
      if (!result.notes && !result.variables)
        throw Error("Provide a not-applicable reason for Notes or Variables.");
      return result;
    }
  );
  const issues: AuthoringReport["issues"] = [];
  const steps: AuthoringReport["steps"] = [];
  let issueCount = 0;
  const issue = (value: AuthoringReport["issues"][number]) => {
    issueCount++;
    if (issues.length < 250) issues.push(value);
  };
  if (!walk.steps.length)
    issue({
      code: "empty-walkthrough",
      message: "Add source cards before checking a generated walkthrough.",
    });
  for (const step of walk.steps) {
    const summary: AuthoringReport["steps"][number] = {
      stepId: step.id,
      blockNotes: 0,
      variables: [],
    };
    steps.push(summary);
    const code = step.code;
    if (!code || step.error) {
      issue({
        stepId: step.id,
        code: "source-unavailable",
        message: "Repair this card's source before completing the walkthrough.",
      });
      continue;
    }
    summary.sourceHash = code.hash;
    summary.fileHash = code.fileHash;
    if (!step.explanation.trim())
      issue({
        stepId: step.id,
        code: "missing-purpose",
        message: "Write the concise overall purpose in the card explanation.",
      });
    if (
      step.stale ||
      step.explanationReviewRequired ||
      step.snapshotHash !== code.hash
    )
      issue({
        stepId: step.id,
        code: "stale-card",
        message:
          "Read current source and deliberately review the card explanation.",
      });
    for (const note of step.notes.filter((n) => !n.archived)) {
      const at = { stepId: step.id, noteId: note.id };
      if (!note.body.trim()) {
        issue({
          ...at,
          code: "missing-note-body",
          message: "Write a meaningful explanation for this entry.",
        });
        continue;
      }
      if (note.stale || note.reviewRequired || note.hash !== code.hash) {
        issue({
          ...at,
          code: "stale-note",
          message:
            "Review this entry against current source and re-author its attachments.",
        });
        continue;
      }
      if (!note.attachments?.length) {
        issue({
          ...at,
          code: "unbound-note",
          message:
            "This entry has no source highlighting. Use a reviewed note with exact current source attachments; plain notes remain saveable but do not pass this generated-guide check.",
        });
        continue;
      }
      const valid = note.attachments.every((range) =>
        note.variableName
          ? wholeIdentifierAttachment(range, note.variableName, code)
          : currentSourceAttachment(range, code)
      );
      if (!valid) {
        issue({
          ...at,
          code: "invalid-attachment",
          message:
            "Reattach this entry to current exact source; Variables must select whole identifiers.",
        });
        continue;
      }
      if (note.body.trim() === step.explanation.trim())
        issue({
          ...at,
          code: "duplicate-purpose",
          message:
            "Explain the block or variable without copying the card purpose.",
        });
      if (note.variableName)
        summary.variables.push({
          noteId: note.id,
          name: note.variableName,
          occurrences: note.attachments.length,
        });
      else summary.blockNotes++;
    }
    const notNeeded = notApplicable.find((entry) => entry.stepId === step.id);
    if (!summary.blockNotes && !notNeeded?.notes)
      issue({
        stepId: step.id,
        code: "missing-block-notes",
        message: "Add relevant source-attached block Notes.",
      });
    if (!summary.variables.length && !notNeeded?.variables)
      issue({
        stepId: step.id,
        code: "missing-variables",
        message: "Add named Variables attached to their whole identifiers.",
      });
  }
  return {
    walkthroughId: walk.id,
    revision: walk.revision,
    ready: issueCount === 0,
    issueCount,
    issues,
    steps,
    notApplicable,
    limitation:
      "Structural source-binding checks only; not proof of explanatory quality, relevant-variable coverage, symbol-binding identity or runtime behavior. No data was changed. Results apply only to the reported revision and source fingerprints.",
  };
}
