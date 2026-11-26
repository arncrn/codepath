import type { ToolName } from "./types.mjs";
import { walkthroughOverviewLimit } from "./types.mjs";
import {
  authoringCompletionRule,
  reviewedNoteRule,
} from "./authoring-policy.mjs";
interface Schema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: (string | null)[];
  minimum?: number;
  maxItems?: number;
  maxLength?: number;
  additionalProperties?: boolean;
}
const str = (description: string): Schema => ({ type: "string", description });
const source = {
  type: "object",
  properties: {
    file: str("Relative project filename"),
    symbol: str("Exact symbol name, or omit and use startLine/endLine"),
    startLine: { type: "integer" },
    endLine: { type: "integer" },
  },
  required: ["file"],
};
const attachments: Schema = {
  type: "array",
  maxItems: 40,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      file: str("Relative highlighted file"),
      fileHash: str("Reviewed full-file fingerprint"),
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      startColumn: { type: "integer", minimum: 0 },
      endColumn: { type: "integer", minimum: 0 },
      text: str(
        "Exact selected text. Columns are zero-based UTF-16; end is exclusive."
      ),
      sourceExcerpt: str(
        "Optional saved relocation context returned by Codepath; checked context is replaced on save"
      ),
      sourceStartLine: { type: "integer", minimum: 1 },
    },
    required: [
      "file",
      "fileHash",
      "startLine",
      "startColumn",
      "endLine",
      "endColumn",
      "text",
    ],
  },
};
const reviewProperties = {
  walkthroughId: str("Path ID"),
  stepId: str("Stable step ID"),
  expectedRevision: { type: "integer", minimum: 1 },
  sourceHash: str("Highlighted source hash from get_walkthrough"),
  fileHash: str("Full-file hash from the reviewed card"),
  body: str("Corrected or deliberately re-reviewed explanation"),
  author: str("Reviewer name"),
  attachments,
};
const notePresentationProperties: Record<string, Schema> = {
  variableName: {
    type: ["string", "null"],
    description:
      "Explicit variable name for the Variables tab. Every attachment must select exactly this whole identifier. Omit to preserve classification; null moves the entry to block Notes.",
  },
  archived: {
    type: "boolean",
    description:
      "Hide an obsolete note from active Notes/Variables without deleting its identity or history. False restores it; omission preserves its current state.",
  },
};
const reviewRequired = Object.keys(reviewProperties);
const define = (
  name: ToolName,
  description: string,
  properties: Record<string, Schema> = {},
  required: string[] = [],
  readOnly = true,
  destructive = false
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: false,
  },
});
const reviewSide: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    file: str("Relative eligible source filename"),
    content: str(
      "Explicit full-file source content, not numbered read_source output; at most 128 KiB"
    ),
    provenance: str(
      "Author-reported origin, e.g. supplied original file or explicitly identified commit. Not independently verified."
    ),
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    purpose: str("Concise card purpose for this side"),
    notes: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          body: str("Block behavior"),
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["body", "startLine", "endLine"],
        additionalProperties: false,
      },
    },
    variables: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          name: str("Exact whole identifier"),
          body: str("What it represents and why"),
          occurrences: {
            type: "array",
            maxItems: 40,
            items: {
              type: "object",
              properties: {
                line: { type: "integer", minimum: 1 },
                startColumn: { type: "integer", minimum: 0 },
              },
              required: ["line", "startColumn"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "body", "occurrences"],
        additionalProperties: false,
      },
    },
    notApplicable: {
      type: "object",
      properties: {
        notes: str("Why block Notes are inapplicable"),
        variables: str("Why Variables are inapplicable"),
      },
      additionalProperties: false,
    },
  },
  required: [
    "file",
    "content",
    "provenance",
    "startLine",
    "endLine",
    "purpose",
    "notes",
    "variables",
  ],
};
const authoredSide: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: str("Meaningful title specific to this source side"),
    purpose: str(
      "Explicit authored purpose, not inferred from a filename or copied across sides"
    ),
    startLine: { type: "integer", minimum: 0 },
    endLine: { type: "integer", minimum: 0 },
    notes: { ...reviewSide.properties!.notes, maxItems: undefined },
    variables: { ...reviewSide.properties!.variables, maxItems: undefined },
    notApplicable: reviewSide.properties!.notApplicable,
  },
  required: ["title", "purpose", "startLine", "endLine", "notes", "variables"],
};
export const tools = [
  define(
    "list_git_explanations",
    "Read lightweight optional authored-step links for exactly matching full paired source binding and selected query. Does not hydrate or rebind walkthroughs, nor prove inventory coverage.",
    {
      query: { type: "object" },
      fileId: str("Git file ID"),
      binding: str("Full exact Git paired binding"),
    },
    ["query", "fileId", "binding"]
  ),
  define(
    "get_git_viewed",
    "Read manual Viewed progress for exactly the source pairs inspected by this Git list. No source or notes are reviewed; unavailable exact identity disables marking.",
    { listId: str("Current Git list ID") },
    ["listId"]
  ),
  define(
    "set_git_viewed",
    "Manually mark one exact Git source pair Viewed, NOT approval. Server freshly checks both raw versions and comparison choices; changed/forged versions and stale progress revisions reject. Exact old versions may recover old status.",
    {
      query: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["changes", "compare"] },
          base: str("Local base choice"),
          target: str("Local target choice or WORKING_TREE"),
        },
        required: ["mode"],
        additionalProperties: false,
      },
      fileId: str("Selected Git pair ID"),
      identity: str("Exact identity from get_git_viewed"),
      expectedRevision: { type: "integer", minimum: 0 },
    },
    ["query", "fileId", "identity", "expectedRevision"],
    false
  ),
  define(
    "clear_git_viewed",
    "Clear only Viewed progress for an exact stored identity/revision, even when source is gone or stale. Retains revision tombstone; never changes notes or source.",
    {
      identity: str("Exact stored Viewed identity"),
      expectedRevision: { type: "integer", minimum: 1 },
    },
    ["identity", "expectedRevision"],
    false
  ),
  define(
    "save_walkthrough_comparison_note",
    "Create or edit one side/card's human annotation on its exact authored paired source. Server freshly admits the stored Git query; expiry needs no human session maintenance. Either side changed rejects, preserving drafts; never reattaches. IDs/history retained. Attachments select exact excerpt bytes; named Variables require whole identifiers, not lexical proof.",
    {
      walkthroughId: str("Authored walkthrough"),
      stepId: str("Paired step ID"),
      binding: str("Stored exact paired binding"),
      side: { type: "string", enum: ["before", "after"] },
      expectedRevision: { type: "integer", minimum: 0 },
      noteId: str("Existing scoped note to edit"),
      body: str("Human annotation"),
      author: str("Author"),
      attachments,
      variableName: str("Optional exact whole identifier"),
    },
    [
      "walkthroughId",
      "stepId",
      "binding",
      "side",
      "expectedRevision",
      "body",
      "author",
      "attachments",
    ],
    false
  ),
  define(
    "delete_walkthrough_comparison_note",
    "After confirmation remove one authored-card annotation without needing source availability. Retain complete identity/history. No source review or rebinding.",
    {
      walkthroughId: str("Authored walkthrough"),
      stepId: str("Paired step ID"),
      scope: str("Exact card annotation scope"),
      noteId: str("Active note"),
      expectedRevision: { type: "integer", minimum: 0 },
    },
    ["walkthroughId", "stepId", "scope", "noteId", "expectedRevision"],
    false,
    true
  ),
  define(
    "create_comparison_walkthrough",
    "Author paired walkthrough steps bound to one admitted Git query. Read list_git_changes and get_git_file first. Source comes only from Git, never caller text. Supply independent side titles/purposes, attached block Notes and named whole-identifier Variables, or explicit genuinely inapplicable reasons. Empty sides require range 0..0 and both N/A reasons. 1 MiB request, 2 MiB saved, 400 lines/excerpt; no fixed pair-count cap. No lexical/prose/behavior proof, no automatic explanation generation or later source rebinding.",
    {
      title: str("Walkthrough title"),
      listId: str("One admitted source query"),
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: str("Stable pairing ID"),
            title: str("Shared navigation label"),
            fileId: str("Admitted file"),
            binding: str("Exact paired Git source binding"),
            before: authoredSide,
            after: authoredSide,
          },
          required: ["id", "title", "fileId", "binding", "before", "after"],
        },
      },
    },
    ["title", "listId", "steps"],
    false
  ),
  define(
    "list_comparison_walkthroughs",
    "List explicitly authored comparison walkthroughs without refreshing or mutating their source."
  ),
  define(
    "get_comparison_walkthrough",
    "Read the stored authored versions, purposes and scoped annotations. These are not current branch tips. No Git refresh, migration or mutation.",
    { id: str("Walkthrough ID") },
    ["id"]
  ),
  define(
    "check_git_comparison",
    "Check whether resolved refs/index/file metadata have changed since listing. Advisory stale feedback only; source bytes are revalidated by get/save operations.",
    { listId: str("Comparison list") },
    ["listId"]
  ),
  define(
    "list_git_branches",
    "Read local branch tips and HEAD. Never checks out or reads another worktree's working files."
  ),
  define(
    "list_git_changes",
    "Read a page of Changes (HEAD to index, index to saved files, untracked) or local-branch comparison. Follow nextCursor until complete, including empty pages. WORKING_TREE includes staged, unstaged and untracked saved files. Read-only; no clean filters or external diff.",
    {
      query: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["changes", "compare"] },
          base: str(
            "HEAD or exact refs/heads/... returned by list_git_branches"
          ),
          target: str("Local ref, HEAD, or WORKING_TREE"),
        },
        required: ["mode"],
        additionalProperties: false,
      },
      cursor: str("Query-bound page continuation"),
    },
    ["query"]
  ),
  define(
    "get_git_file",
    "Read exact before/after source and hunks for an admitted changed file. Files/index/branch movement require refresh. Does not write source or metadata.",
    { listId: str("From list_git_changes"), fileId: str("From the file list") },
    ["listId", "fileId"]
  ),
  define(
    "save_comparison_note",
    "Create or edit a human annotation attached to one exact side of a Git comparison. Both sources, scope and annotation revision must still match; never writes ordinary walkthrough notes or source. Retains IDs/history on edit.",
    {
      listId: str("Comparison list"),
      fileId: str("Selected file"),
      binding: str("Exact comparison binding returned by get_git_file"),
      side: { type: "string", enum: ["before", "after"] },
      expectedRevision: { type: "integer", minimum: 0 },
      noteId: str("Existing note ID to edit, omit to create"),
      body: str("Human annotation"),
      author: str("Author"),
      attachments,
      variableName: str(
        "Optional exact whole identifier; attachments must select that name"
      ),
    },
    [
      "listId",
      "fileId",
      "binding",
      "side",
      "expectedRevision",
      "body",
      "author",
      "attachments",
    ],
    false
  ),
  define(
    "delete_comparison_note",
    "After confirmation remove one active comparison annotation, retaining identity/history. Source need not still be available; this is not re-review.",
    {
      scope: str("Annotation scope from get_git_file"),
      noteId: str("Note ID"),
      expectedRevision: { type: "integer", minimum: 0 },
    },
    ["scope", "noteId", "expectedRevision"],
    false,
    true
  ),
  define(
    "create_change_review",
    "Legacy compatibility only, not the Git reader workflow. Capture an immutable bounded before/after review (one or more cards, 512 KiB total; no fixed card-count cap). Explicit source on both sides; after must exactly match live saved source. No Git baseline required or inferred. Include former behavior, changed behavior and reason plus attached Notes/named Variables or explicit inapplicability reasons. No update/auto-fix operation.",
    {
      id: str("Optional unique review ID; existing IDs cannot be replaced"),
      title: str("Selected change"),
      cards: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: str("Unique card ID"),
            title: str("Change location"),
            beforeBehavior: str("Former behavior"),
            afterBehavior: str("Changed behavior"),
            reason: str("Why the change is needed"),
            before: reviewSide,
            after: reviewSide,
          },
          required: [
            "id",
            "title",
            "beforeBehavior",
            "afterBehavior",
            "reason",
            "before",
            "after",
          ],
        },
      },
    },
    ["title", "cards"],
    false
  ),
  define(
    "list_change_reviews",
    "Legacy compatibility: list saved immutable records. The reading interface uses Git changes/branch comparison instead."
  ),
  define(
    "get_change_review",
    "Legacy compatibility: read immutable before/after source and explanations, fingerprints/provenance and separate current live-source match/changed/unavailable status. Never refreshes saved snapshots.",
    { id: str("Review ID") },
    ["id"]
  ),
  define(
    "project_overview",
    "Read walkthrough/run summaries and lightweight source-discovery progress. Use list_source_files/find_symbols for paged discovery and inspect_source for one file; overview does not parse the repository.",
    {
      walkthroughId: str(
        "Optional currently read walkthrough; check its source metadata even if another client is reading a different walkthrough"
      ),
    }
  ),
  define(
    "read_source",
    "Read any eligible project source file on demand, with line numbers and a current source fingerprint. Discovery order and cache residency do not restrict access.",
    {
      file: str("Relative file"),
      startLine: { type: "integer" },
      endLine: { type: "integer" },
    },
    ["file"]
  ),
  define(
    "inspect_source",
    "Load one eligible source file's current symbols, line count and fingerprint on demand.",
    { file: str("Relative source file") },
    ["file"]
  ),
  define(
    "list_source_files",
    "Discover eligible source filenames without parsing them. Follow nextCursor until complete, including empty pages; cursors expire and are bound to this query.",
    {
      query: str("Optional case-insensitive filename substring"),
      cursor: str("Continuation from the preceding page"),
    }
  ),
  define(
    "find_symbols",
    "Search source symbols on demand by name or filename. Follow nextCursor until complete; a partial page is not an exhaustive or unique result.",
    {
      query: str("Optional case-insensitive symbol or filename substring"),
      cursor: str("Continuation from the preceding page"),
    }
  ),
  define(
    "search_source",
    "Search literal text across eligible source files in bounded pages. Follow nextCursor until complete, including empty pages.",
    {
      query: str("Literal case-insensitive text"),
      cursor: str("Continuation from the preceding page"),
    },
    ["query"]
  ),
  define(
    "follow_calls",
    "Suggest possible calls by name matching, not proven runtime edges. Follow nextCursor until complete; unresolvedComplete is false until the complete search can report unmatched calls.",
    {
      source,
      cursor: str(
        "Continue candidate search until complete; partial results are not exhaustive"
      ),
    },
    ["source"]
  ),
  define(
    "resolve_reference",
    "Find name-based candidates for one identifier at a saved source position. Go matches stay in the same package. Not type resolution or execution evidence.",
    {
      file: str("Relative eligible file, regardless of cache residency"),
      cursor: str("Continue candidate search until complete"),
      identifyOnly: {
        type: "boolean",
        description:
          "Validate/name the clicked identifier without a project fallback scan; use before native definition lookup",
      },
      line: { type: "integer", minimum: 1 },
      column: {
        type: "integer",
        minimum: 0,
        description: "Zero-based UTF-16 character position",
      },
    },
    ["file", "line", "column"]
  ),
  define(
    "get_walkthrough",
    "Read a path, live code and notes; inspect stale indicators.",
    { id: str("Path ID") },
    ["id"]
  ),
  define(
    "validate_walkthrough",
    "Read-only final authoring check: card purposes, current source-attached block Notes and explicitly named whole-identifier Variables. A successful tool call is not completion: fix issues until ready is true. Does not write or judge semantic quality.",
    {
      walkthroughId: str("Walkthrough ID"),
      expectedRevision: { type: "integer", minimum: 1 },
      notApplicable: {
        type: "array",
        maxItems: 60,
        description:
          "Only for genuinely irrelevant categories; explicit reasons bound to the source you read. Does not excuse stale/unbound existing entries or assess whether the reasoning is true.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            stepId: str("Card ID"),
            sourceHash: str("Current card source hash"),
            fileHash: str("Current full-file hash"),
            notes: str("Why no separate block Notes are relevant"),
            variables: str("Why no variable explanations are relevant"),
          },
          required: ["stepId", "sourceHash", "fileHash"],
        },
      },
    },
    ["walkthroughId", "expectedRevision"]
  ),
  define(
    "source_usages",
    "Batch reverse source usages for every step in a saved walkthrough. Exact resolved ranges and overlapping ranges are separate. Unresolved references are not matches. This is source navigation, not execution or recursion evidence.",
    { walkthroughId: str("Walkthrough ID") },
    ["walkthroughId"]
  ),
  define(
    "save_walkthrough",
    "Create/update the ordered cards and their concise purposes; this does not create Notes, Variables or source highlights. For generated walkthroughs also include a Markdown overview with the big picture, mental model and worked example; legacy/manual guides may omit it. Read source first; mark uncertain connections inferred. Updates need expectedRevision and preserve notes by stable step ID. " +
      reviewedNoteRule +
      " " +
      authoringCompletionRule,
    {
      id: str("Omit for new ID"),
      title: str("Behavior name"),
      description: str("Short situation and outcome"),
      overview: {
        ...str(
          "Markdown main page: big picture, key concepts, a concrete worked example and important caveats. Author from source, not card-title guesses. Omission preserves existing content; an empty string clears it."
        ),
        maxLength: walkthroughOverviewLimit,
      },
      expectedRevision: { type: "integer" },
      steps: {
        type: "array",
        maxItems: 60,
        items: {
          type: "object",
          properties: {
            id: str("Stable step ID"),
            title: str("Step title"),
            source,
            explanation: str(
              "Brief overall purpose of the code shown in the card. Put block/function-call explanations in Notes; use reviewed notes with variableName for individual Variables entries. Do not duplicate the card summary. For reviews explain before versus after; omit setup/provenance boilerplate."
            ),
            evidence: { type: "string", enum: ["source", "inferred"] },
            callbackRole: {
              type: ["string", "null"],
              enum: [
                "registration",
                "definition",
                "activation-call-site",
                null,
              ],
              description:
                "Explicit author-assigned role of this source range, not proof of execution. Registration passes or binds a callback; definition declares its body; activation-call-site is code that invokes it if reached. Read source before assigning. Omit to preserve an existing role; use null to clear it. Does not change connection evidence or run data.",
            },
            sample: { type: "object", properties: { input: {}, output: {} } },
          },
          required: ["id", "title", "source"],
        },
      },
    },
    ["title", "steps"],
    false
  ),
  define(
    "save_walkthrough_overview",
    "Create or edit the ordinary walkthrough's Markdown main page/cheat sheet without rewriting cards, source references, Notes, Variables, runs or Flow. Explain the big picture, key concepts and a concrete example. Read get_walkthrough first and pass its revision; conflicts reject without dropping the draft. Empty text explicitly clears. Text is authored, not automatically source-reviewed or execution evidence.",
    {
      walkthroughId: str("Walkthrough ID"),
      expectedRevision: { type: "integer", minimum: 1 },
      overview: {
        ...str("Exact Markdown overview text, including headings and examples"),
        maxLength: walkthroughOverviewLimit,
      },
    },
    ["walkthroughId", "expectedRevision", "overview"],
    false
  ),
  define(
    "save_walkthrough_flow",
    "Explicitly author a source-bound behavioral explanation graph, not reading order or runtime proof. Read every selected source and establish imported/lexical call identity; never infer calls from card order or bare names. Include true/false decisions, joins, loop/recursion edges where relevant and unresolved nodes for opaque/dynamic connections. The origin node selection supports each edge; basis is authored reasoning, not verified semantics. Preserve existing card purposes, Notes and Variables; Flow does not review them. Omitted Flow remains valid for legacy guides. Re-read get_walkthrough after saving and require flowState.status=current, then semantically review relationships. Graph=null explicitly clears. Budgets reject, never truncate: 120 nodes, 240 edges, 256 KiB.",
    {
      walkthroughId: str("Existing walkthrough ID"),
      expectedRevision: { type: "integer", minimum: 1 },
      graph: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          version: { type: "integer", minimum: 1, description: "Must equal 1" },
          summary: str(
            "Concise selected behavior and limits/omissions, up to 1200 characters"
          ),
          nodes: {
            type: "array",
            maxItems: 120,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: str("Unique graph-local stable ID"),
                stepId: str(
                  "Known stable card ID; independent of reading order"
                ),
                kind: {
                  type: "string",
                  enum: [
                    "entry",
                    "process",
                    "decision",
                    "join",
                    "call",
                    "exit",
                    "unresolved",
                  ],
                },
                label: str("Plain text, up to 300 characters"),
                sourceHash: str(
                  "Current displayed code.hash, NOT snapshotHash"
                ),
                attachment: attachments.items!,
              },
              required: [
                "id",
                "stepId",
                "kind",
                "label",
                "sourceHash",
                "attachment",
              ],
            },
          },
          edges: {
            type: "array",
            maxItems: 240,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                from: str(
                  "Origin graph node ID, whose exact source selection supports this relation"
                ),
                to: str("Destination graph node ID"),
                kind: {
                  type: "string",
                  enum: [
                    "next",
                    "true",
                    "false",
                    "call",
                    "return",
                    "loop",
                    "recursion",
                    "unresolved",
                  ],
                },
                label: str("Plain text, up to 200 characters; empty allowed"),
                basis: str(
                  "Reviewed source reasoning, up to 1200 characters; disclose conditional continuations and uncertainty"
                ),
              },
              required: ["from", "to", "kind", "label", "basis"],
            },
          },
        },
        required: ["version", "summary", "nodes", "edges"],
      },
    },
    ["walkthroughId", "expectedRevision", "graph"],
    false
  ),
  define(
    "delete_walkthrough",
    "Permanently delete one walkthrough, its notes and its runs, never source files. Only after user confirmation. Pass the confirmed revision; concurrent notes, runs or path edits require fresh review.",
    {
      id: str("Walkthrough ID"),
      expectedRevision: {
        type: "integer",
        minimum: 1,
        description: "Revision reviewed and confirmed by the user",
      },
    },
    ["id", "expectedRevision"],
    false,
    true
  ),
  define(
    "add_note",
    "Add a deliberate plain/manual note. It is unclassified and unanchored: no colored source highlighting and no Variables entry. Do not use this tool for generated block Notes or Variables. " +
      reviewedNoteRule,
    {
      walkthroughId: str("Path ID"),
      stepId: str("Step ID"),
      body: str("Note"),
      author: str("Your agent name"),
    },
    ["walkthroughId", "stepId", "body", "author"],
    false
  ),
  define(
    "delete_note",
    "After confirmation, remove one active note from Notes/Variables. Retains stored identity and history; does not review source and works for missing/stale source.",
    {
      walkthroughId: str("Path ID"),
      stepId: str("Step ID"),
      noteId: str("Note ID"),
      expectedRevision: { type: "integer", minimum: 1 },
    },
    ["walkthroughId", "stepId", "noteId", "expectedRevision"],
    false,
    true
  ),
  define(
    "add_reviewed_note",
    reviewedNoteRule +
      " Each attachment must identify the current file/hash and exact selected text/range. Use variableName only for separate Variables entries, with whole-identifier attachments. An empty attachment array is allowed only for intentional plain/manual notes; it does not satisfy generated-guide readiness.",
    { ...reviewProperties, ...notePresentationProperties },
    reviewRequired,
    false
  ),
  define(
    "review_note",
    "Correct or deliberately re-review a note, keeping its ID and full prior history. Check the current highlighted source and path revision first. Re-author stale attachments or explicitly clear them.",
    {
      ...reviewProperties,
      ...notePresentationProperties,
      noteId: str("Existing note ID"),
    },
    [...reviewRequired, "noteId"],
    false
  ),
  define(
    "review_explanation",
    "Correct or deliberately re-review the card explanation, retaining prior text and review history. Does not refresh other notes.",
    reviewProperties,
    reviewRequired,
    false
  ),
  define(
    "repair_step_source",
    "Repair a missing or incorrect source reference without marking any old explanations reviewed. Use current indexed source and full-file fingerprint; review content separately.",
    {
      walkthroughId: str("Path ID"),
      stepId: str("Stable step ID"),
      expectedRevision: { type: "integer", minimum: 1 },
      source,
      fileHash: str("Reviewed replacement file fingerprint"),
    },
    ["walkthroughId", "stepId", "expectedRevision", "source", "fileHash"],
    false
  ),
  define(
    "focus_step",
    "Focus a path and step in the connected UI.",
    { walkthroughId: str("Path ID"), stepId: str("Step ID") },
    ["walkthroughId", "stepId"],
    false
  ),
  define(
    "list_runs",
    "List runs belonging to a walkthrough.",
    { walkthroughId: str("Path ID") },
    ["walkthroughId"]
  ),
  define(
    "get_run",
    "Read an imported or recorded run.",
    { id: str("Run ID") },
    ["id"]
  ),
  define(
    "record_run",
    "Import data. Use example for invented values and recorded only for actual instrumentation. Does not execute code. Include sourceHash only when the executed file revision is known.",
    {
      walkthroughId: str("Path ID"),
      label: str("Scenario"),
      mode: { type: "string", enum: ["example", "recorded"] },
      origin: str("How the values were obtained"),
      events: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            stepId: str("Path step ID"),
            input: {},
            output: {},
            sourceHash: str(
              "Executed file fingerprint from read_source, if known"
            ),
            at: str("Timestamp"),
          },
          required: ["stepId"],
        },
      },
    },
    ["walkthroughId", "label", "mode", "origin", "events"],
    false
  ),
];
