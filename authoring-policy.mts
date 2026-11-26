import type { ToolName } from "./types.mjs";

// Shared verbatim by MCP initialization and the in-app agent instructions.
export const authoringCompletionRule =
  "Saving cards is not a completed generated walkthrough. After authoring, get_walkthrough and validate_walkthrough with its current expectedRevision. Fix every issue and repeat until ready is true. A successful tool call alone is not readiness. If a request fails or times out, report the walkthrough as incomplete, not finished.";
export const reviewedNoteRule =
  "For generated block Notes and Variables use add_reviewed_note (or review_note for existing IDs) with nonempty, exact current source attachments. Never use add_note for these: it creates deliberately unanchored plain text, not colored blocks or Variables.";
export const plainLanguageRule =
  "Write for someone following the code, not someone reviewing implementation paperwork. A card purpose says what the code does and its important result or condition in one or two sentences. A block Note explains the selected statements or call and why a branch or update matters; do not repeat the purpose. A named Variable explains what its value represents and how the code uses it. Prefer concrete actions such as loads the walkthrough, ignores an older reply, checks the linked code, or keeps each card's draft separate. Use real function and variable names where useful, but explain unfamiliar terms instead of relying on words such as binding, projection, admission, scope, lifetime or fail-closed. Before and After must each explain their own code; never copy one side to fill the other.";
export const walkthroughAuthoringInstructions = [
  "Read current source before mapping the requested behavior. Include only relevant calls and connections; mark uncertain connections inferred. Codepath contains no embedded AI: use the connected authoring tools rather than editing workspace.json.",
  "For a generated current-state walkthrough, also author its Markdown overview main page: a concise big picture, key concepts/mental model, at least one concrete worked example, and important assumptions or caveats. Use save_walkthrough.overview on creation, or save_walkthrough_overview with the latest revision for overview-only edits. Keep the short description separate. Read back the overview and check its usefulness against source; validate_walkthrough checks card/Note/Variable bindings, not overview quality or completeness. Legacy/manual walkthroughs remain readable without an overview; never invent it from card titles alone.",
  "For every applicable card, author all three explanation homes in the first generation, without waiting for another user request: (1) a concise overall behavior/purpose in the card explanation, (2) relevant block/function-call explanations in Notes, and (3) separate named Variables explaining what each relevant variable represents and why it is used—not just its type and not one combined glossary. Do not copy the card purpose into Notes.",
  plainLanguageRule,
  reviewedNoteRule +
    " Block Notes must select the relevant block/call ranges so their code and Notes get matching colors. Variables must set variableName and attach exact whole-identifier occurrences of that binding; exclude unrelated/shadowed names and never infer bindings or classification from prose.",
  "Use review_explanation for card corrections/re-review and review_note for existing entries. Use get_walkthrough for current sourceHash (code.hash), fileHash (code.fileHash), full-file lines and expectedRevision. Attachment coordinates are one-based lines and zero-based UTF-16 columns with an exclusive end; text must exactly match current source. Re-read the walkthrough after every mutation to obtain its new revision. Preserve existing card/note IDs and history; explicitly review stale explanations, never just refresh hashes or discard drafts/notes. Do not invent dummy explanations or silently archive plain notes to make a check pass.",
  authoringCompletionRule +
    " validate_walkthrough is read-only and checks current source bindings, not semantic quality or coverage. You must also read back every card's content and verify that the important blocks and variables are explained. For a genuinely inapplicable Notes/Variables category, provide an explicit notApplicable reason with the current card/file hashes and disclose that exception; never use it to bypass stale, unbound or invalid entries.",
  "When the user requests behavioral Flow, use save_walkthrough_flow after reading the current cards/source. Author source-bound nodes and typed calls, true/false decisions, joins, loops and recursion independently of reading order. Establish call identity from lexical/import/transport facts, never a bare name match or adjacent cards. Represent dynamic, opaque or unsupported connections explicitly as unresolved. Each origin selection must support its edges; basis is your reviewed reasoning, not independently verified execution. Read back flowState.status=current and semantically review the complete selected explanation. Flow is optional for legacy/manual guides and never replaces or re-reviews the three explanation homes. Limits reject rather than truncate: 120 nodes, 240 edges, 256 KiB. Never make users paste Mermaid/JSON just to see the flow.",
  "Use short actions or understandable questions for Flow labels: Check linked code, Did any source check fail?, or Keep this card's draft. Check that each question's true/yes and false/no arrows match what that question asks; do not reverse a condition just to shorten a label. Describe a call's continuation as happening only if the call returns successfully, and name what is not known instead of inventing a connection. Keep API field names, precise source checks and authoring limits in technical guidance rather than using them as substitutes for explanations.",
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
