# Q&A Knowledge Base

### Q: Why separate current Git coverage, immutable explanations and Viewed identity?

**A:** A saved authored walkthrough is a selected source snapshot, not an exhaustive live inventory. Current changes enumerates every allowed candidate and reports restricted/unknown coverage separately; optional links require a matching full paired binding and query. Viewed identifies raw paired versions/modes/paths/group/choices independently of preview availability or whole-index/ref movement. The existing workspace is the single synchronous writer: fresh Git admission finishes before the final owner fence and current-state progress CAS/save/rollback. Exact old versions can recover old progress; tombstones retain revision protection after clearing. No notes migrate or become reviewed.

### Q: Why verify patch/raw rows instead of computing another whole-file diff?

**A:** The safe Git provider already supplies bounded real hunks. A linear verifier checks their raw text/context/coordinates and pads insertion/deletion/replacement rows without quadratic LCS or guessed normalized offsets. Unsupported mapping is explicitly plain. Authored selections use bounded selected windows; disconnected/unrelated excerpts fall back independently rather than acquiring thousands of empty rows. Shared header tracks align code origins while prose heights stay independent.

### Q: Why have both card descriptions and Notes, and why were the Notes in 00 empty?

**A:** The original 00 content populated card summaries but did not add detailed Notes. The card description explains the whole function's purpose at a high level; Notes explain blocks/function calls at a medium level and individual variables at a low level, without duplicating the summary. All eight cards now have three detailed Notes each.

### Q: Why should UI actions use named operations rather than generic string-based tool calls?

**A:** Functions such as `getWalkthrough(walkthroughId)` make the action and its typed input/result explicit at the call site. `ui/api.ts` keeps the generic protocol names and payload serialization private, while `ui/transport.ts` carries the request over browser HTTP or VS Code messages.

### Q: What does “superseded replies” mean in Codepath?

**A:** These are responses to older requests that a newer request has made irrelevant. If you open walkthrough A, then B, and A's response arrives last, Codepath ignores A's response rather than replacing B. The older request may still finish successfully; its result is simply no longer wanted for the current view.

### Q: Why did the 0.7.0 guide add so many notes?

**A:** The added individual notes were meant to provide help for specific variables, but they were also shown as ordinary notes while the older multi-variable glossaries remained, duplicating information. Source-alignment and attachment tests did not establish that the explanations were useful or the interface readable; the user's review found that failure. A one-card content example is under review before changing more saved learning content.

### Q: What did “live guide publication awaits an updated owner” mean?

**A:** The updated walkthroughs and code-linked explanations were ready, but the running Codepath service was still an older version that could not safely apply them. “Owner” means the service process responsible for saving this project's data. Reloading VS Code and reopening Codepath starts the updated service, after which the guide can be updated through its API while preserving existing notes and history.

### Q: What is formal/service-ownership/statecharts/README.md for?

**A:** It is a generated visual report supporting the service data-loss fix: the bounded model checks one writable owner, retention of acknowledged saves and preservation of another owner's connection record. Its diagrams show normal ownership transitions and failure traces from deliberately broken variants; they are developer verification evidence, not runtime code or the proposed function-call layout. Generated reports were later removed during repository cleanup; the maintained model, correspondence and verification scripts remain, and the views can be regenerated when needed.

### Q: Why does Codepath have hard limits, and what blocks monorepo-scale use?

**A:** The former 200-source-file/5,000-entry cutoffs were prototype guardrails, not fundamental limits; the revised implementation uses progressive metadata discovery, on-demand parsing and an evictable parsed-source cache, so unrelated files or cache residency no longer determine whether a known eligible filename can be opened. Paging/work/cache budgets now bound requests and retained parsed data rather than repository coverage, while per-file, card and attachment bounds remain. Whole-file card payloads, whole-workspace JSON saves and repeated attachment context are still scaling costs, and synthetic regressions do not establish performance on the user's real monorepo on another machine.

### Q: How many walkthroughs can be stored, and could the AI reload historical ones from an archive?

**A:** There is no explicit walkthrough-count cap, although all saved paths/notes/history still live in one loaded workspace.json record that is rewritten on saves, so practical capacity is not guaranteed. The proposed archive retains inactive walkthrough knowledge rather than historical code; reloading reconnects explanations to current source and refreshes what is stale, with archiving separate from staleness and PR review focused on behavioral changes relative to the target/base. Separate walkthrough archive storage is not implemented; the new on-demand source cache is a different feature and no longer imposes a permanent 200-file eligibility budget.

### Q: Why could an agent save Notes but produce no Variables or source highlights?

**A:** The old copied prompt grouped variable purposes under Notes, while `add_note` can save only unclassified/unanchored prose, so successful writes did not establish the required three-home explanation structure. Updated source shares one UI/MCP authoring policy and offers read-only `validate_walkthrough`: generated guides need current attached block Notes and explicitly named whole-identifier Variables (or explicit source-bound inapplicability reasons), with incomplete results signaled as MCP errors/CLI exit 1. Plain/manual/unfinished notes remain saveable; validation does not infer bindings, rewrite data, establish semantic quality or guarantee that an external model obeys the workflow.

### Q: What does .codepaths-ignore exclude?

**A:** It already excludes project-relative file/directory prefixes from source indexing, one per line; blank/comment lines are skipped, but glob patterns and negation are not supported. It does not replace .gitignore or archive/delete saved walkthroughs, and live cards whose source is excluded can no longer resolve that source. Source-index scoping and a future historical walkthrough archive are complementary features, not the same operation.

### Q: Why can a worktree's Codepath viewer show another implementation without switching the main checkout?

**A:** A Git worktree is already a separate checkout on its own branch, and its Codepath service was started with that directory as the project root and its own compiled build as the viewer/backend assets. It reads that worktree's source and private .codepaths data, independently of the main checkout's current branch. This is a separate rooted service, not automatic Git branch switching or reading branch contents from the main directory.

### Q: Why does the immutable-capture review walkthrough not show diffs?

**A:** The first implementation captured immutable source rather than computing Git differences; the user rejected that scope, and the corrected isolated viewer now provides staged/unstaged/untracked Changes plus branch or saved-working-tree comparisons, editable/deletable notes and non-red/pink annotation colors without capture-management or bulk AI controls. Branch comparisons use committed tips, not another checkout’s uncommitted files; choose Working tree for saved uncommitted changes. The tips initially shared `50147c7`, but main subsequently advanced to `ea201c1`, so only genuinely equal tips should show no differences.

### Q: Why does the saved Change reviews comparison have only one code block per side?

**A:** The saved review-capture-implementation deliberately contains one comparison card for the workspace.mts dispatch change, so it renders one Before/After pair. The format no longer has a fixed comparison-card count cap after the user's requested removal, but it does not automatically collect all worktree changes; the separate 16-card current-code walkthrough covers more of the implementation. This capture is a focused example, not a complete before/after review of the worktree, and its limited coverage should be clear.

### Q: Why limit a captured review to eight before/after pairs?

**A:** The intent was a prototype resource guardrail: each pair retains full before/after source and annotations, capture/persistence are synchronous, and the UI renders all pairs without paging. Eight was an arbitrary implementation choice, not a measured threshold, fundamental requirement or user-requested review boundary. At the user's request the runtime/tool-schema count cap was removed in the review worktree, while the nonempty-review, source-size, selection and 512 KiB input/expanded-storage safeguards remain.

### Q: How do I enable AI discussions in the ticket-20 browser viewer?

**A:** The browser viewer was initially started without an agent; configuration belongs to the owning server, not the browser or MCP client. Restart that viewer with explicit trusted pi-oauth settings for installed Pi 0.85.1, openai-codex/gpt-6.1-sol and the authorized existing auth/cached-catalog paths; this path needs no separate API key, while starting another server cannot reconfigure the current owner. Normal provider refresh may update the authorized login, but no prompt is sent until the reader selects context, reviews the disclosure and explicitly sends; the ticket-20 README contains the startup command.

### Q: Why is approved source editing browser-only in the ticket-20 increment?

**A:** That was the initial increment's implementation gap, not an inherent browser requirement; the isolated ticket-20 worktree now supports undoable native editor-buffer application in its owning VS Code host, without saving. It requires a clean, unchanged target, Auto Save off and compatible UTF-8 configuration; attached/wrong-host sessions fail closed rather than falling back to disk writes, and later user Save/format/re-encoding is outside the buffer operation. This worktree build is not installed in the user's real VS Code; browser application still checks saved disk only and cannot see arbitrary unsaved external buffers.

### Q: Why can Request edit still have a disabled Preview request (formerly Review send)?

**A:** Text alone is not sufficient: the selected discussion context must still match current source, the agent must be configured, and no reply/action may be pending. In the reported session the agent was enabled and no reply was pending, but the preserved discussions.mts context was stale after the implementation changed that file. Select the desired current source lines and explicitly choose Use selected lines as new context; this preserves the draft and earlier conversation without silently relabeling old source. The corrected viewer makes Request edit visible above history, replaces the technical disclaimer with plain instructions and shows the blocking reason beside Preview request.

### Q: Why does ticket-28 show only a horizontal chain of boxes?
**A:** Its first implementation connected cards in saved reading order, not code flow. The user rejected that model and confirmed Flow should show source-supported calls, decisions, branches and loops linked to relevant cards; rearranging the same linear chain is not a fix. The corrected isolated viewer now renders an explicitly authored, exact-source-bound graph with card navigation—not an automatically inferred complete call graph or a runtime trace.

### Q: What does Repair source reference do?

**A:** It reconnects a saved walkthrough card to its intended source after a file/range moves or becomes unavailable; it does not repair or edit the code. That maintenance action is separate from re-reviewing explanations and does not make old notes current. It does not belong in the branch-comparison reading interface.

### Q: Why is there no fixed count cap on legacy before/after review pairs?

**A:** The original eight-pair cap was an arbitrary prototype guardrail, not a domain requirement or measured threshold, and was removed at the user's request. Those legacy compatibility operations retain their source/range/byte budgets. They are no longer the reader's comparison workflow.

### Q: What should Git comparisons mean now?

**A:** Inspect actual differences, not manage captured reviews. Changes separates HEAD→index, index→saved file and empty→untracked. Compare uses explicit local branch tips/HEAD, optionally targeting the current saved working tree (including untracked). Equal committed branches really are equal even when working files differ; no artificial staging, commits or checkout should be used to make an example look changed. The reader has no capture/identity/provenance/live-status controls and generates no explanatory prose or AI requests.

### Q: Does Delete note mean source review or loss of history?

**A:** No. Confirmation removes the active entry using existing archive metadata, while preserving its ID, source binding and prior versions. It works with stale or unavailable source without stamping a new hash. Scope/revision conflicts reject rather than delete newer work. This applies to ordinary Notes/Variables and separate exact-side comparison annotations; it does not restore reader-facing archive/history panels.

### Q: Can natural Git differences be shown without executing clean filters?

**A:** Yes for safe built-ins. Changes uses pure text/EOL/ident conversion and working-only filemode rules for eligibility/hunks, while full-file display, attachment hashes and save admission retain exact raw source. Stored index/branch blobs remain literal. Custom filters and unsupported encodings are explicitly unknown, never guessed modifications or clean results. Only needed non-executable configuration keys and effective ignore/attribute data paths are read; repository commands are never copied or executed, even if configuration changes during a request. See README for supported rules and budgets. Red/pink remains reserved for removed diff lines, not annotation shading.
