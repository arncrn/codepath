# Writing a walkthrough's Flow

Flow is a diagram that explains what the selected code does: calls, decisions, branches and loops. Its boxes open the cards that explain that code. It is **not** a diagram of the order in which cards were saved, and it is not a recording of execution.

The connected authoring agent reads the code and supplies the diagram. Readers should not have to paste Mermaid or JSON to see it. Mermaid is the local drawing library; Codepath supplies the boxes, arrows and labels.

## Write for someone following the code

Use short actions and understandable questions. Describe the behavior first; use an implementation term only when it helps explain the statements being shown.

| Avoid relying on this wording | Say what happens                           |
| ----------------------------- | ------------------------------------------ |
| Check every exact binding     | Check linked code                          |
| Any invalid binding?          | Did any source check fail?                 |
| Project the current graph     | Prepare the diagram for display            |
| Fail closed on stale scope    | Stop when the linked code has changed      |
| Discard obsolete reply        | Ignore the reply for the earlier selection |
| Keep drafts scoped            | Keep each card's unfinished note separate  |

These are writing examples, not substitutions to apply without reading the code. For instance, ignoring a finished drawing does **not** mean its calculation was cancelled.

### Keep the three explanation homes distinct

- **Purpose:** in one or two sentences, say what this code does and its important result or condition.
- **Notes:** explain the selected statements, call or branch. Describe what is checked or changed and why that matters. Do not repeat the purpose.
- **Variables:** name one real variable and explain what its value represents and how the code uses it. Do not make a combined glossary or describe only its type.

For `projectWalkthroughFlow`, a useful purpose is:

> Checks whether the diagram's saved links still match the code. If a card is missing or its source has changed, marks the diagram out of date; otherwise prepares it for display.

A Note on its `filter` block can explain:

> `filter` collects boxes whose source is missing, unreadable or changed. One failed check blocks the whole diagram; it does not silently move a box to different code.

A separate Variable explanation for `invalid` is:

> The boxes that failed the source checks. An empty list means every box still matches its recorded code.

Attach the Note to that block and the Variable to the exact occurrences of `invalid`. Passing source checks does not prove that the author chose the right arrows. Read the code to check their meaning too.

Before and After explanations must describe their **own** code. Explain what changed without copying After into Before, inventing a missing file, or calling historical source current.

## Choose honest boxes and arrows

Each box selects code that supports its description. Each arrow explains a connection supported by that code, not by neighboring cards or matching function names alone.

- Ask a real question at each decision. Check both destinations: **true/yes** must answer that question, and **false/no** must answer its opposite. "No saved diagram?" and "Is there a saved diagram?" need opposite destinations; changing the wording must not reverse the explanation accidentally.
- Say **if the call succeeds** or **after the call returns** for a caller's continuation. A call can throw, and an arrow is not evidence that it returned during a real run.
- Show separate starting points for separate operations, such as reading a diagram and saving an update. Do not connect them just to make one chain.
- Mark an unknown connection as unresolved. Name what is not shown: for example, "Mermaid draws the diagram; its internal layout steps are not covered here."
- State what the selected diagram leaves out. It need not cover every function or possible execution path.

## What readers see when source changes

Codepath checks each linked card, the selected-code hash and the exact file/range/text recorded for the box. A missing card, unreadable source or changed source makes the whole diagram out of date. Changes elsewhere in a referenced file can also fail its full-file hash check.

An out-of-date diagram is not drawn and its old box-to-card actions cannot navigate. Reading does not delete boxes, move links to similar-looking code, change saved hashes or mark explanations reviewed. An author must read the new code and deliberately update the diagram. Card purposes and Notes can need review independently of the diagram.

If no diagram was authored, show that absence; never invent arrows from card order. Flow remains optional for existing/manual walkthroughs and does not replace the three explanation homes.

## Technical authoring reference

Read `get_walkthrough` for the current walkthrough revision and each displayed `step.code`. Save with `save_walkthrough_flow({walkthroughId, expectedRevision, graph})`. Use `graph:null` only to explicitly clear Flow. Saves advance the walkthrough revision; read it again after each mutation.

The optional saved graph has `version:1`, a concise `summary`, `nodes` and `edges`:

- A node has graph-local `id`, `stepId`, `kind`, plain-text `label`, current displayed `code.hash` as `sourceHash`, and one exact `SourceAttachment`. The attachment includes `code.fileHash`, exact text and UTF-16 coordinates inside that card. Do **not** substitute the older reviewed `snapshotHash`; relocation context is forbidden.
- Node kinds: `entry`, `process`, `decision`, `join`, `call`, `exit`, `unresolved`.
- An edge has `from`, `to`, `kind`, plain-text `label` (which may be empty), and a nonempty `basis` explaining the source reasoning. Its origin selection must support the relation.
- Edge kinds: `next`, `true`, `false`, `call`, `return`, `loop`, `recursion`, `unresolved`. Each decision needs exactly one true and one false edge to different destinations. Calls and recursion start at call nodes. An unresolved edge identifies an unresolved endpoint.

The rejection limits are **1–120 nodes, 0–240 edges and 256 KiB UTF-8 graph JSON**. Node labels allow 300 characters, edge labels 200, summaries and bases 1200. Excess input is rejected, not truncated. IDs, endpoints, attachment shape and branch structure are checked on save and reload. These checks do not establish the meaning of a call or branch.

`get_walkthrough.flowState` reports `absent`, `current` or `stale` without writing. `walkthrough-flow.mts` owns validation, source checks and Mermaid generation. Existing revision checks, single-writer admission and synchronous save/rollback still apply. Ordinary card/note edits retain the graph; removing a card or repairing its source makes affected links stale rather than silently rewriting them.

## Drawing, card selection and drafts

The pinned local Mermaid renderer produces SVG, the browser's vector-image format. Codepath copies only allowed SVG elements and attributes before adding its own card-selection actions. It never inserts the library's HTML or retains scripts, external resources, event handlers, `foreignObject`, click directives or `bindFunctions`.

Only known generated box IDs with current card mappings get trusted mouse and Enter/Space actions. A click checks the latest walkthrough again, so a later source update cannot leave an old diagram navigating to the wrong card. Drawing jobs run one at a time and check whether their view has closed before starting and after finishing. An already-running Mermaid calculation is not aborted; an old result is ignored.

Selecting a box stays in Flow and selects/scrolls its card without calling the persisted `focus_step` tool. Plain-note drafts are kept separately by walkthrough and card. A save reply clears only that card's unchanged submitted draft, not a newer edit or another card's text. These drafts are memory-only, not durable recovery or reading-context storage. Fit gives an overview; Actual size keeps readable scrolling.

## Guarded example publication

`scripts/author-semantic-flow.mjs` is an opt-in recipe for the historical `review-ticket-28` guide. Its original 14 cards describe an older implementation. Preserve their IDs, explanations and history; do not silently move their source ranges or stamp them reviewed. The recipe adds eight focused cards for the corrected behavior, each with a purpose, block Note and named Variable. It is not an automatic live update.

1. Supply a parent-owned client with `.call(name,args)`; the recipe does not discover private data or read credentials.
2. Call `prepareSemanticFlowPublication(client, guideId)`. It reads the current revision and exact source, checks every selector and prepares all three homes without writing. Existing addition IDs stop duplicate publication.
3. Review the prepared text and every arrow against the code. Only then call `publishSemanticFlow(client, plan)`.
4. Publication checks the reviewed revision/source, adds cards and reviewed Notes through public tools, then saves the graph using the **captured reviewed code**. It checks every file/hash/range again after the final Note. A source change stops publication; it must not replace the captured hashes with newer ones. Partial additions remain visible as incomplete work rather than being rolled back over concurrent edits.
5. Read back `flowState.status === "current"` and inspect every new card and box. Inspect `validate_walkthrough`; old stale cards remain honestly unreviewed. Readiness is not a judgement of prose or diagram quality.

The selected examples cover showing a diagram, queued drawing and old replies, recursive SVG copying, checking linked code, checking diagram format, saving/clearing with failure recovery, and keeping card drafts separate. Parser details and Mermaid's internal layout are not expanded into an exhaustive graph. Call identities come from actual lexical definitions/imports, never just their names. Flow metadata belongs to ordinary walkthroughs; this increment does not add diagrams to Before/After comparison pairs.

## Verification

- `npm test`: public graph admission/reload/revision/source checks, deletion/repair/budgets/rollback/legacy preservation, and publication guards including changes after the last Note and final read.
- `npm run test:flow` / `npm run test:flow:vscode`: actual Chrome/disposable native diagrams, mouse/keyboard links, independent card drafts, CSP, malicious labels, size limits, stale source and queued/in-flight results.
- `node scripts/test-semantic-publication.mjs`: the same guarded recipe on disposable copies of actual application source, with all three homes, nonlinear Flow and Chrome navigation. It does not read or write a private live guide.

Automated checks protect structure, source identity and rendering behavior. Human review decides whether the explanations are understandable and useful. No model calls, new dependency versions, external renderers or automatic source/data edits are introduced by this writing change.
