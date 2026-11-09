import type { ToolName } from "./types.mjs";
interface Schema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: (string | null)[];
  minimum?: number;
  maxItems?: number;
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
export const tools = [
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
    "source_usages",
    "Batch reverse source usages for every step in a saved walkthrough. Exact resolved ranges and overlapping ranges are separate. Unresolved references are not matches. This is source navigation, not execution or recursion evidence.",
    { walkthroughId: str("Walkthrough ID") },
    ["walkthroughId"]
  ),
  define(
    "save_walkthrough",
    "Create/update an ordered walkthrough. Read source first. Explain what each highlighted range does, not navigation provenance or setup history. In code reviews describe behavior before and after the change. Mark uncertain connections inferred. Updating needs expectedRevision from get_walkthrough. Existing notes are preserved by step ID.",
    {
      id: str("Omit for new ID"),
      title: str("Behavior name"),
      description: str("Situation and outcome"),
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
    "Add an unclassified block explanation to Notes. The card explanation already gives the overall purpose; do not duplicate it. For individual Variables entries use add_reviewed_note with variableName and whole-identifier attachments. Source changes mark the note stale.",
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
    "add_reviewed_note",
    "Add an explicitly source-reviewed block note, or an explicitly named variable explanation with precise attachments. Pass an empty attachment array for an unanchored block note.",
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
