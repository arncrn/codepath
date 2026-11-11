# Changelog

## 0.8.1 — source-linked authoring contract

- Share the complete Card / attached block Notes / named attached Variables policy between UI guidance and MCP initialization; remove conflicting plain-note guidance.
- Add read-only `validate_walkthrough` with revision/source-aware diagnostics, explicit source-bound inapplicability reasons and failed MCP/CLI status for incomplete guides.
- Keep manual/plain notes and unfinished walkthroughs saveable; never infer classifications/bindings or rewrite notes during validation.
- Reuse exact current-source/whole-identifier predicates across validation, saved variable checks and rendering.
- Bundle agent/tool entries so shared policy needs no extra VSIX sidecar.

Validation checks structure/source bindings, not explanatory usefulness or external-model compliance. After installing, reload the owning Codepath window and reconnect the external MCP client using the current in-app configuration/instructions; an older process can retain the previous policy and tools.

## 0.8.0

- Replace the 200-source-file/5,000-entry coverage cutoffs with progressive metadata discovery and on-demand source loading.
- Reuse unchanged parsed source in an evictable cache; cache residency and traversal order no longer determine file eligibility.
- Add paged filename/symbol/text discovery and candidate search, including explicit completion and continuation.
- Load native selection/definition targets directly, and prefer native definitions before broader fallback searches.
- Keep reader freshness scoped to the selected walkthrough so unrelated discovery does not repeatedly reload its cards.
- Retain source/revision guards, private walkthrough data and the existing persisted format.
- Refuse unsupported older owners without stopping them; align extension, MCP and UI release versions.

Remaining limits include supported languages, source exclusions, 1 MiB per source file, whole-file card payloads and whole-workspace JSON saves. Real-monorepo performance on another machine, Windows/Linux and remote extension hosts remain unverified. Walkthrough archive storage, automatic main-integration/PR generation and the branching layout are separate work.
