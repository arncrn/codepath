# TODO

## Definition of MVP complete

Use Codepath to **review and learn Codepath itself**. It is not MVP-complete until you understand the application and can comfortably use the tool with its own source. A feature checklist or passing automated tests cannot establish that on your behalf.

The practical acceptance test: you can choose a behavior, follow its highlighted code through the application and back to the visible result, explain what you read, and return to that context without fighting the UI. For a review, the explanations should make the behavior before versus after a change clear.

## Effort scale

Effort estimates are for **remaining work**, including tests, not the original cost of completed work. Version 0.7.0 integrates the ownership fix and authorized small-feature batch. Loading it requires a VS Code window reload. Own-guide attachment publication follows activation; the user's hands-on acceptance remains separate.

- **1–3: Simple** — small, localized changes.
- **4–6: Moderate** — changes across UI, data or protocol boundaries.
- **7–8: High effort** — substantial integration and source/concurrency safety work.
- **9–10: Very high effort** — major workflow or runtime-instrumentation work.

Scores are relative estimates, not time commitments. Scope assumptions are called out below. Related items share work, so their scores should not be added together. This list is planning, not authorization to implement.

## Ticket dependencies

`ticket-n` identifies a local task in this file, not a GitHub issue. Keep IDs stable when moving or completing tasks. Never renumber existing tickets.

Every task has a `blocked by` field. `none` means no unfinished prerequisite prevents starting that task. Named tickets are required prerequisites, not related work or a preferred order. Completed prerequisites no longer block. Technical readiness alone is not permission to implement. The current run authorizes ticket-6 plus unfinished, unblocked tickets scored 4 or below: ticket-12, ticket-13, ticket-14, ticket-17, ticket-22, and ticket-23. Higher-effort and blocked tasks remain outside that grant. Ticket-16 still requires the user's own acceptance after its blocker clears. A missing product example is a scope question, not a made-up ticket dependency.

## Completed

- [x] ticket-1. Convert to TypeScript.
  - blocked by: none.
  - Codepath's application and VS Code extension use strict TypeScript. Native build/test scripts, compatibility entry points and mixed-language examples intentionally retain JavaScript.
- [x] ticket-2. Add formatter.
  - blocked by: none.
  - Prettier, gofmt, format-on-save and staged formatting are configured. Normalizing every pre-existing file is separate from formatter setup.
- [x] ticket-3. Add linter.
  - blocked by: none.
  - ESLint is configured; commit hooks also run TypeScript checks and tests. Go vet is available separately.
- [x] ticket-4. Convert to React.
  - blocked by: none.
  - Codepath's shared browser and VS Code webview UI uses React/TSX, not just the sample app.
- [x] ticket-5. Split `ui.tsx` by responsibility.
  - blocked by: none.
  - The entry only mounts App. Reading state, walkthrough commands, drafts, source navigation, run presentation/import, dialogs, and layout have feature owners. Existing behavior and learning-reference IDs are preserved.

## Service data-loss fix

- [x] ticket-6. Prevent overlapping service starts from losing accepted saves.
  - blocked by: none.
  - Implemented and verified in 0.7.0. Existing editor owners still require reload; source changes do not hot-upgrade them.
  - Before the fix, overlapping starts could open independent writable snapshots and acknowledge saves that later disappeared. A failed owner probe could also retain a snapshot loaded before the old owner's final save.
  - Updated processes acquire one lifetime canonical-root OS reservation before loading writable state, recheck discovery and load fresh state. Shutdown fences writes, drains HTTP/handlers/owned children, token-checks connection cleanup and releases last. Healthy published legacy owners are reused, not overwritten.
  - Parent checks pass separate-process overlap, delayed failed probe, crash recovery, aliases/collisions, live/unknown PID refusal, startup cleanup, incomplete bodies, async drainage, foreign tokens and real-Go termination failures. All three finite invariants and actual-source replays pass in 893 states. Three scratch mutations still reproduce the protected failures.
  - The guarantee requires cooperating updated writers on one host and canonical root. It is not cross-host locking, power-loss durability or an unbounded proof. See `formal/service-ownership/README.md`.

## Recommended work toward the self-learning MVP

The authorization section above governs this run. Unfinished tasks outside that grant remain proposals. Start with content and the existing workflow; add UI only where it removes a demonstrated obstacle.

- [x] ticket-7. Finish and verify the current card-clarity change — **3/10 · Simple, provisional**.
  - blocked by: none.
  - Remove the “Source-linked” badge; use plain language only when an uncertain connection actually needs a warning. Do not pass navigation or setup boilerplate off as an explanation of code.
  - Browser and desktop checks pass. The stale-deletion failure was a test ordering race: the test now waits for the actual reviewed confirmation before introducing the concurrent note. Production deletion guards were not weakened.

- [x] ticket-8. Rewrite the existing walkthrough explanations and agent notes from the current Codepath source — **4/10 · Moderate**.
  - blocked by: none.
  - For each highlighted range, explain what runs here, what information it receives or changes, what it returns, and any important condition. Explain unfamiliar syntax when it affects understanding.
  - Replace outdated architecture/setup commentary and review reports with explanations of the code actually shown. Preserve useful review findings separately rather than presenting them as learning notes.
  - The 69 card explanations/highlights are rewritten and published. Live activation of all 27 original note replacements is verified, with original text/authors/timestamps/hashes retained in history. Version 0.6.1 also publishes 24 detailed Notes across 00's eight cards. The 0.6.1 five-note maintenance batch was applied before the UI refactor. The seven-note 0.6.2 source-move batch is confirmed applied and archived. The 0.7.0 source and attachment refresh is now applied through the updated service's reviewed APIs and verified live. All original 51 notes, 39 prior history entries and 19 samples are preserved; no old note hashes were silently reset.

- [x] ticket-9. Add a short “Start here: how Codepath fits together” walkthrough — **2/10 · Simple**.
  - blocked by: none.
  - Use the existing cards to introduce the React UI, VS Code host/bridge, local service, workspace storage, source indexer and external-agent adapter. Explain each piece's job and the boundaries between them.
  - Provide a suggested reading order for the existing behavior walkthroughs. This is curated content, not a new graph, onboarding wizard or documentation platform.

- [x] ticket-10. Make each highlighted range teach one understandable part of a behavior — **3/10 · Simple**.
  - blocked by: none.
  - Review the real Codepath paths for huge function selections, irrelevant context and missing call sites. Prefer the smallest useful range that still explains the operation; keep surrounding context accessible.
  - Check that the explanation describes those exact lines. Make request-to-handler and result-to-UI transitions explicit so the path does not stop at an outbound call.

- [x] ticket-11. Add concrete Codepath examples to its own learning paths — **2/10 · Simple for illustrative fixtures**.
  - blocked by: none.
  - Show a small walkthrough-save payload, the relevant stored fields, a revision change, and the resulting UI state using the existing data panel. Teach this application, not only the checkout sample.
  - Clearly label invented values as examples. Capturing a few real Codepath checkpoints is a separate, optional **5/10** increment; exclude session tokens and do not imply a full execution trace.

- [x] ticket-12. Make existing explanations straightforward to correct and deliberately re-review — **4/10 · Moderate**.
  - blocked by: none.
  - Implemented with ticket-13. Explicit source/revision-checked correction and repair retain IDs/history. Generic edits cannot borrow an earlier review or silently reset its source hash. Preview and delayed-dialog races have actual-browser regressions.
  - Allow a wrong or obsolete explanation to be corrected against the current highlighted source, without duplicating notes or losing useful history. Make an unresolved source reference repairable without pretending the old explanation is still valid.
  - This is the explicit human/agent-reviewed first increment of “Ensure notes are updated” below, not automatic AI rewriting. The work overlaps; do not count it twice. The general correction/re-review UI and named agent operations now supplement the older maintenance-batch mechanism.

- [x] ticket-13. Attach explanations to the specific code they explain — **4/10 · Moderate for Codepath's displayed code**.
  - blocked by: none.
  - Implemented with ticket-12 and published after the user reloaded and reopened Codepath. The 0.7.0 technical checks did not establish usefulness: the user rejected flat variable-note lists and immediate oversized popups. They approved a card-purpose / block Notes / named Variables layout. Version 0.7.1 implements it, with explicit classification, reversible archive/history and deliberate variable reveal. Its first-card content reorganization is applied and verified live, retaining all old IDs/history and archiving the duplicate glossary. Native-info work remains queued. In 0.7.2 the user explicitly removed reverse-reference panels, introductory teaching text, and reader-facing history/archive/revision-guard controls. Stored versions and internal checks remain; no replacement panels are authorized. After accepting that cleanup, the user approved colored block-note highlighting and select lines → Create note. Version 0.7.3 implements matching colors/overlap markers and automatic whole-line attachments, with independent drafts and unchanged source/revision checks. Existing live attachments are colored without content writes; actual browser and installed native workflows pass. The user confirmed this block-to-note connection, then explicitly requested consistent organization on all cards. The reviewed batch is now applied to all 78 cards in seven paths, with twelve repaired source links, 160 active block Notes and 369 named Variables. All 110 original note IDs/versions and other saved data are retained; live retry is zero-write and actual UI checks cover every card. Overall ticket-16 acceptance remains separate. Original IDs/history/samples are preserved.
  - Hover over a variable, function or code block to preview its attached explanation(s); click to reveal/scroll the relevant card(s) or detailed Notes into view. Handle multiple matches without jumping unpredictably or stealing focus. Preserve existing definition-navigation gestures and provide keyboard access.
  - Store explicit, source-version-checked attachments to precise code ranges (including columns for variables), rather than guessing from names or explanation prose. Same-named variables in different scopes must not match accidentally. Existing cards already had whole-source ranges. New optional note/card attachments now identify precise variable/block ranges while retaining old unanchored notes.
  - Add attachment authoring through the relevant UI/agent operations, preserve existing unanchored notes, and split/re-anchor 00's grouped explanations where necessary. One explanation may cover several ranges; one range may have several explanations.
  - Safely relocate attachments when possible; flag changed/ambiguous/missing source for review rather than silently showing an explanation against the wrong code. Include persistence, overlapping-range, stale-source, hover/click and keyboard regression tests.
  - Native VS Code editor interaction and finding matches across walkthroughs increase the scope to approximately **6/10**. Automatically linking every use of a symbol is additional scope, not assumed in the explicit-attachment increment. Shares anchoring work with inline review comments and code-block conversations below.
  - Initially deferred under the very-small-change approval. Now authorized by the unblocked-effort-4-or-below implementation request.

- [x] ticket-14. Show all walkthroughs that reference the same code — **4/10 · Moderate**.
  - blocked by: none.
  - Closed/withdrawn from the reading UI at the user's explicit request in 0.7.2: remove Source usages, unresolved saved references and their disclaimer. The derived read-only backend query remains tested. Do not reintroduce its panels or polling without new authorization.
  - Existing step source ranges support this task independently of ticket-13's finer variable and explanation attachments.
  - A referenced function, code block, or source range should expose links to every walkthrough and step that uses it, not only the currently selected walkthrough. Selecting a reference should open that walkthrough at the matching step.
  - Treat this as a many-to-many relationship between source locations and walkthrough steps. Derive reverse references from saved walkthroughs rather than inserting comments into source files or maintaining duplicate backlink lists.
  - Keep references accurate after walkthrough creation, source-reference edits, step removal, walkthrough deletion, and source relocation. Use canonical files and resolved ranges or scoped symbol identities; matching text names alone must not combine unrelated functions.
  - Handle overlapping ranges, repeated steps, and unresolved source explicitly. This is navigation among walkthroughs, separate from attaching detailed explanations to variables or blocks above. Include update, deletion, ambiguity, and navigation tests.

- [x] ticket-15. Keep my place while learning — **4/10 · Moderate**.
  - blocked by: none.
  - Restore the last walkthrough, selected step and notes/data tab after reopening or reloading the tool. Keep that state scoped to the workspace and handle deleted paths/steps gracefully.
  - Agent-requested focus should be intentional and understandable, not unexpectedly overwrite what the user is reading. No bookmarks system or navigation redesign is assumed.

- [ ] ticket-16. Run a hands-on Codepath-on-Codepath acceptance session — **2/10 · Simple to run; fixes estimated separately**.
  - blocked by: none.
  - Ticket-6's prerequisite, updated-service activation and reviewed guide publication are complete. The user's hands-on reliability and learning acceptance can now proceed. Optional backlog features are not prerequisites.
  - Have you drive: start from a real Codepath selection, follow a definition, read an existing end-to-end path, explain its behavior, add a useful explanation, and reopen the same context.
  - Record confusing labels, missing explanations, lost context and reliability problems separately from code-learning notes. Turn actual blockers into focused follow-up tasks instead of guessing at more features.
  - Repeat until you confirm that you understand the application and can comfortably use the tool with it. This—not an agent declaring the tests green—is the MVP completion gate.

## Broader backlog

These remain useful candidates, but are not all prerequisites for the self-learning MVP. Prioritize them only when the learning/review sessions show the need.

- [x] ticket-17. Add language-engine highlighting — **4/10 · Moderate**.
  - blocked by: none.
  - Implemented local JS/TS/JSX/TSX/Go grammars. Exact escaped text, multiline state, whole identifier wrappers, attachments and native-navigation composition pass browser and installed desktop checks.
  - Exact VS Code theme/semantic-token parity is a larger scope: approximately **8/10**.

- [ ] ticket-18. Support code editing — **7/10 · High effort**.
  - blocked by: none.
  - Syntax coloring in ticket-17 is not required for a functional editor.
  - Opening source in the native VS Code editor already works. This score assumes editing inside cards, with save/cancel, undo, dirty-buffer/conflict handling and source refresh.
  - Supporting safe inline editing in the standalone browser too increases the scope to approximately **9/10**.

- [ ] ticket-19. Support code review — **6/10 · Moderate**.
  - blocked by: none.
  - Current-source reviews can use existing source references and external-agent access. Inline comments, conversations, and editing are separate increments, not prerequisites.
  - External agents can already review source and publish source-linked notes. A dedicated review workflow still needs explicit scope, structured findings, reviewed-source fingerprints and finding status.
  - Assumes current-source review, not a complete Git/PR diff-review system or automatic fixes. See the inline review-comments item below for that interaction.
  - A useful first review increment is one real Codepath change with explicit before/after source snapshots and explanations of the changed behavior: approximately **5/10**. Do not assume a Git commit baseline exists, or turn this into a full PR platform.

- [ ] ticket-20. Support AI conversation at code blocks/lines — **8/10 · High effort**.
  - blocked by: ticket-13.
  - Reuse ticket-13's durable block/line attachments for persistent conversation context rather than creating a competing anchor system.
  - Notes exist, but conversations do not. Needs an integration with the chosen agent, line/block anchors, persistent threads, context disclosure, response delivery, cancellation and stale-context handling.
  - Existing MCP access lets an agent call Codepath; it does not let Codepath initiate a chat with that agent.

- [ ] ticket-21. Ensure notes are updated as code is updated — **8/10 · High effort**.
  - blocked by: none.
  - Ticket-12's correction/re-review prerequisite is complete. Automatic agent-proposed changes remain higher-effort and are not authorized by the small-ticket grant.
  - Some relocation and stale-note warnings already work. This score assumes agent-proposed changes to note text, reviewed against the correct source version—not merely moving an unchanged note.
  - Explicit human review/editing/re-anchoring without AI rewriting is a smaller scope: approximately **4/10**. Hash equality alone cannot establish that an explanation is still correct.

- [x] ticket-22. Improve UI for callback functions — **3/10 · Simple**.
  - blocked by: none.
  - The original implementation added author-assigned registration/definition/call-site roles. In 0.7.4 the user explicitly removed the Callback role… card control; stored role metadata and backend tests remain, and direct callback-identifier navigation is intact. The user has a different future calls/recursion structure in mind using vertical lists and arrows, like Excalidraw. Wait for their design rather than reintroducing this control or implementing a replacement speculatively.
  - Automatic recognition across frameworks or reconstructing actual callback execution is not included; that would be substantially more work.

- [x] ticket-23. Improve UI for recursive behavior — **4/10 · Moderate**.
  - blocked by: none.
  - The bounded occurrence UI was implemented with ticket-14, then withdrawn with the Source usages panel in 0.7.2 at the user's request. Distinct step IDs, notes, samples and run values remain separate. This closure does not authorize a replacement recursion UI.
  - Assumes bounded repeated-source cues and navigation within the existing ordered cards. Repeated functions with independent step IDs already work.
  - A repeated function is not proof of recursion. Showing actual invocation depth, arguments and returns needs instrumentation: approximately **9/10**.

- [ ] ticket-24. Improve UI for “stacked” function calls — **5/10 · Moderate, provisional**.
  - blocked by: none.
  - Scope still needs a concrete example. This is a product clarification, not an unfinished implementation dependency.
  - Assumes nested/chained source expressions such as `outer(inner(value))` or `service.load().save()`, with call-site grouping and navigation.
  - Needs a concrete example before settling scope. If this means runtime stack frames instead, estimate **9/10**; existing checkpoint events cannot reconstruct a full stack.

- [ ] ticket-25. Add the `+` inline code-review comments functionality — **9/10 · Very high effort for the full workflow**.
  - blocked by: ticket-13, ticket-19, ticket-20.
  - These blockers apply to the full workflow: durable attachments, review batches/status, and agent discussion. The local button/draft subset can start independently, but does not complete this ticket. General inline code editing in ticket-18 is not required merely to preview and apply an explicitly approved patch.
  - After clicking **Submit for review**, send the comments and selected source context to the AI to discuss and/or propose changes.
  - The `+` button and local inline comment drafts alone are approximately **3/10**.
  - The full workflow needs durable line anchors, a review batch, agent transport, replies/status, source-version checks, and safe proposed-edit preview/application with explicit approval and undo. Discussion-only submission is smaller than adding code changes too.
  - Shares substantial infrastructure with code review, AI conversations and code editing above; it is not an additional independent system.

## Effort and priority summary

- **Best early learning value:** rewrite the current explanations (**4/10**), add the short architecture orientation (**2/10**), and tighten highlighted ranges (**3/10**).
- **Cheap ways to test usefulness:** illustrative Codepath data (**2/10**) and a hands-on acceptance session (**2/10**, before estimating any fixes it reveals).
- **Comfort and maintenance:** explanation correction/re-review, code-to-explanation attachments within Codepath, and restoring reading context (**4/10** each). Editor-wide/cross-walkthrough attachments are approximately **6/10**.
- **Smaller broader features:** callback presentation and the inline comment/draft portion (**3/10** each); syntax coloring and source-only recurrence cues (**4/10** each).
- **Defer unless the learning/review workflow needs them:** full inline AI review with code changes (**9/10**), AI conversations (**8/10**), and automatic semantic note updates (**8/10**).
