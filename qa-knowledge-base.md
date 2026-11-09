# Q&A Knowledge Base

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

### Q: What does .codepaths-ignore exclude?

**A:** It already excludes project-relative file/directory prefixes from source indexing, one per line; blank/comment lines are skipped, but glob patterns and negation are not supported. It does not replace .gitignore or archive/delete saved walkthroughs, and live cards whose source is excluded can no longer resolve that source. Source-index scoping and a future historical walkthrough archive are complementary features, not the same operation.
