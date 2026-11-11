import type { ToolName } from "./types.mjs";

// Shared verbatim by MCP initialization and the in-app agent instructions.
export const authoringCompletionRule =
  "Saving cards is not a completed generated walkthrough. After authoring, get_walkthrough and validate_walkthrough with its current expectedRevision. Fix every issue and repeat until ready is true. A successful tool call alone is not readiness. If a request fails or times out, report the walkthrough as incomplete, not finished.";
export const reviewedNoteRule =
  "For generated block Notes and Variables use add_reviewed_note (or review_note for existing IDs) with nonempty, exact current source attachments. Never use add_note for these: it creates deliberately unanchored plain text, not colored blocks or Variables.";
export const walkthroughAuthoringInstructions = [
  "Read current source before mapping the requested behavior. Include only relevant calls and connections; mark uncertain connections inferred. Codepath contains no embedded AI: use the connected authoring tools rather than editing workspace.json.",
  "For every applicable card, author all three explanation homes in the first generation, without waiting for another user request: (1) a concise overall behavior/purpose in the card explanation, (2) relevant block/function-call explanations in Notes, and (3) separate named Variables explaining what each relevant variable represents and why it is used—not just its type and not one combined glossary. Do not copy the card purpose into Notes.",
  reviewedNoteRule +
    " Block Notes must select the relevant block/call ranges so their code and Notes get matching colors. Variables must set variableName and attach exact whole-identifier occurrences of that binding; exclude unrelated/shadowed names and never infer bindings or classification from prose.",
  "Use review_explanation for card corrections/re-review and review_note for existing entries. Use get_walkthrough for current sourceHash (code.hash), fileHash (code.fileHash), full-file lines and expectedRevision. Attachment coordinates are one-based lines and zero-based UTF-16 columns with an exclusive end; text must exactly match current source. Re-read the walkthrough after every mutation to obtain its new revision. Preserve existing card/note IDs and history; explicitly review stale explanations, never just refresh hashes or discard drafts/notes. Do not invent dummy explanations or silently archive plain notes to make a check pass.",
  authoringCompletionRule +
    " validate_walkthrough is read-only and checks current source bindings, not semantic quality or coverage. You must also read back every card's content and verify that the important blocks and variables are explained. For a genuinely inapplicable Notes/Variables category, provide an explicit notApplicable reason with the current card/file hashes and disclose that exception; never use it to bypass stale, unbound or invalid entries.",
  "Keep setup history, navigation provenance and separate review findings out of code explanations. For PR review explain current/base behavior versus proposed changes at the relevant levels. Use example mode for invented values and never present illustrative data as observed execution.",
].join("\n\n");

export function authoringCheckFailed(name: ToolName, result: unknown): boolean {
  return (
    name === "validate_walkthrough" &&
    (!result ||
      typeof result !== "object" ||
      !("ready" in result) ||
      result.ready !== true)
  );
}
