import crypto from "node:crypto";
import { hash } from "./indexer.mjs";
import { parseFile, sourceExtensions } from "./source-parser.mjs";
import { functionContext } from "./source-functions.mjs";
import { parseAttachments } from "./annotations.mjs";
import {
  saveComparisonNote,
  validateComparisonNotes,
} from "./comparison-notes.mjs";
import type {
  AdmittedGitFile,
  AuthoredComparisonSide,
  ComparisonWalkthroughInput,
  ComparisonWalkthrough,
  ComparisonNote,
  GitQuery,
  SourceCode,
  FunctionScopes,
  FunctionContext,
  SavedComparisonWalkthrough,
  SavedComparisonStep,
  SourceAttachment,
  WalkthroughComparisonNoteInput,
} from "./types.mjs";

function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
// Includes authoritative query, paired identities, source bytes/code/patch,
// purposes and ranges. Only mutable annotation contents/revisions are excluded.
// This detects accidental corruption, not malicious edits or prose falsehoods.
function sourceSeal(
  saved: Omit<SavedComparisonWalkthrough, "sourceSeal">
): string {
  return (
    "sha256-v1:" +
    crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          id: saved.id,
          title: saved.title,
          query: saved.query,
          sources: saved.sources,
          steps: saved.steps.map(({ annotations, ...step }) => ({
            ...step,
            scope: annotations.scope,
          })),
        })
      )
      .digest("hex")
  );
}
function validateSources(saved: SavedComparisonWalkthrough) {
  need(
    saved.sourceSeal === sourceSeal(saved),
    "Authored source integrity seal mismatch or missing."
  );
  const ids = new Set<string>();
  for (const [id, source] of Object.entries(saved.sources)) {
    need(
      id === source.file.id && !source.unavailable,
      "Invalid authored source identity."
    );
    for (const side of [source.before, source.after]) {
      const code = side.code;
      need(
        typeof side.content === "string" &&
          code &&
          !side.unavailable &&
          code.file === side.file &&
          code.lines.join("\n") === side.content &&
          code.fileHash === hash(side.content) &&
          code.hash === hash(side.content) &&
          code.excerpt === side.content &&
          code.startLine === 1 &&
          code.endLine === code.lines.length,
        "Authored source integrity: incoherent raw text/code/hash."
      );
    }
  }
  for (const step of saved.steps) {
    const source = saved.sources[step.fileId];
    need(
      !ids.has(step.id) &&
        source &&
        step.binding === source.binding &&
        step.annotations.scope ===
          crypto
            .createHash("sha256")
            .update(JSON.stringify([saved.id, step.id, source.scope]))
            .digest("hex"),
      "Authored source integrity: invalid paired identity/binding."
    );
    ids.add(step.id);
  }
}
const MAX_SAVED_BYTES = 2 * 1024 * 1024;
const MAX_VIEW_BYTES = 8 * 1024 * 1024;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Reserve the complete current version for every active note, plus JSON/history
// punctuation and revision digit growth. Deleting consumes this reserve, so ALL
// active entries remain removable even when saving another version is refused.
function archivalReserve(note: ComparisonNote): number {
  if (note.archived) return 0;
  // Same current-version fields preserved by noteRevision/deleteComparisonNote,
  // without cloning the note's entire history or attachment text to count it.
  return (
    jsonBytes({
      body: note.body,
      author: note.author,
      at: note.at,
      hash: note.hash,
      binding: note.binding,
      side: note.side,
      ...(note.attachments === undefined
        ? {}
        : { attachments: note.attachments }),
      ...(note.variableName === undefined
        ? {}
        : { variableName: note.variableName }),
      ...(note.archived === undefined ? {} : { archived: note.archived }),
    }) + 64
  );
}
function reserve(saved: SavedComparisonWalkthrough): number {
  return saved.steps.reduce(
    (total, step) =>
      total +
      step.annotations.notes.reduce(
        (bytes, note) => bytes + archivalReserve(note),
        0
      ),
    0
  );
}
// One local parse per immutable file/side for a projection or budget pass.
// Never consult the live project's AST or persist the derived label.
type ScopeProjection = Map<
  AdmittedGitFile["before"],
  FunctionScopes | undefined
>;
function projectStep(
  saved: SavedComparisonWalkthrough,
  step: SavedComparisonStep,
  scopes: ScopeProjection
) {
  const source = saved.sources[step.fileId];
  function side(
    raw: AdmittedGitFile["before"],
    meta: SavedComparisonStep["before"]
  ) {
    const code = excerpt(raw, meta);
    if (!scopes.has(raw))
      scopes.set(
        raw,
        sourceExtensions.has(raw.file.slice(raw.file.lastIndexOf(".")))
          ? parseFile(raw.file, raw.content!).functionScopes
          : undefined
      );
    const context: FunctionContext = code.excerpt.trim()
      ? functionContext(
          scopes.get(raw),
          raw.content!,
          meta.startLine,
          meta.endLine
        )
      : { status: "unknown", reason: "empty selection" };
    return {
      ...raw,
      ...meta,
      code: { ...code, functionContext: context },
    };
  }
  return {
    ...step,
    file: source.file,
    patch: source.patch,
    patchMatchesRaw: source.patchMatchesRaw,
    before: side(source.before, step.before),
    after: side(source.after, step.after),
  };
}
// Count one projected card at a time, NEVER stringify/clone a giant full view to
// discover it is over budget. This conservative wire policy preserves all fields
// and source eligibility rather than imposing a step-count cutoff.
export function assertComparisonBudget(saved: SavedComparisonWalkthrough) {
  const headroom = reserve(saved);
  need(
    jsonBytes(saved) + headroom <= MAX_SAVED_BYTES,
    "Saved authored walkthrough exceeds 2 MiB including archival headroom; previous state kept."
  );
  let bytes =
    jsonBytes({
      id: saved.id,
      title: saved.title,
      query: saved.query,
      steps: [],
    }) + headroom;
  const scopes: ScopeProjection = new Map();
  for (const step of saved.steps) {
    bytes += jsonBytes(projectStep(saved, step, scopes)) + 1;
    need(
      bytes <= MAX_VIEW_BYTES,
      "Expanded authored view exceeds 8 MiB including archival headroom; previous state kept."
    );
  }
}
function object(value: unknown): Record<string, unknown> {
  need(
    !!value && typeof value === "object" && !Array.isArray(value),
    "Invalid authored walkthrough object."
  );
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 10000): string {
  need(
    typeof value === "string" && !!value.trim() && value.length <= max,
    "Authored text missing or too long."
  );
  return value.trim();
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  need(
    Object.keys(v).every((k) => allowed.includes(k)),
    "Unexpected authored field; source text/provenance are supplied only by Git."
  );
}
function integer(value: unknown): number {
  need(
    Number.isSafeInteger(value) && Number(value) >= 0,
    "Invalid authored source range."
  );
  return Number(value);
}
function sideInput(value: unknown): AuthoredComparisonSide {
  const v = object(value);
  keys(v, [
    "title",
    "purpose",
    "startLine",
    "endLine",
    "notes",
    "variables",
    "notApplicable",
  ]);
  need(
    Array.isArray(v.notes) && Array.isArray(v.variables),
    "Provide separate Notes and Variables arrays."
  );
  const notes = v.notes.map((value) => {
    const n = object(value);
    keys(n, ["body", "startLine", "endLine"]);
    return {
      body: text(n.body),
      startLine: integer(n.startLine),
      endLine: integer(n.endLine),
    };
  });
  const variables = v.variables.map((value) => {
    const n = object(value);
    keys(n, ["name", "body", "occurrences"]);
    need(Array.isArray(n.occurrences), "Provide variable occurrences.");
    return {
      name: text(n.name, 200),
      body: text(n.body),
      occurrences: n.occurrences.map((value) => {
        const r = object(value);
        keys(r, ["line", "startColumn"]);
        return { line: integer(r.line), startColumn: integer(r.startColumn) };
      }),
    };
  });
  const exceptions =
    v.notApplicable === undefined ? {} : object(v.notApplicable);
  keys(exceptions, ["notes", "variables"]);
  const notApplicable: AuthoredComparisonSide["notApplicable"] = {};
  for (const category of ["notes", "variables"] as const) {
    if (exceptions[category] !== undefined)
      notApplicable[category] = text(exceptions[category], 2000);
    const entries = category === "notes" ? notes : variables;
    need(
      entries.length > 0 ? !notApplicable[category] : !!notApplicable[category],
      `Provide ${category} attachments or one explicit source-bound notApplicable reason, not both.`
    );
  }
  const startLine = integer(v.startLine),
    endLine = integer(v.endLine);
  need(
    endLine >= startLine && endLine - startLine < 400,
    "Authored excerpt exceeds 400 lines or has invalid range."
  );
  return {
    title: text(v.title, 200),
    purpose: text(v.purpose),
    startLine,
    endLine,
    notes,
    variables,
    ...(Object.keys(notApplicable).length ? { notApplicable } : {}),
  };
}
// Validate request structure/bytes BEFORE Git subprocess dispatch.
export function parseComparisonAuthoring(
  value: unknown
): ComparisonWalkthroughInput {
  need(
    Buffer.byteLength(JSON.stringify(value) ?? "") <= 1024 * 1024,
    "Authored input exceeds 1 MiB."
  );
  const v = object(value);
  keys(v, ["title", "listId", "steps"]);
  need(
    Array.isArray(v.steps) && v.steps.length > 0,
    "Provide authored paired steps."
  );
  const ids = new Set<string>();
  return {
    title: text(v.title, 200),
    listId: text(v.listId, 100),
    steps: v.steps.map((value) => {
      const s = object(value);
      keys(s, ["id", "title", "fileId", "binding", "before", "after"]);
      const id = text(s.id, 100);
      need(
        /^[A-Za-z0-9_-]+$/.test(id) && !ids.has(id),
        "Invalid or duplicate step ID."
      );
      ids.add(id);
      const binding = text(s.binding, 64);
      need(/^[a-f0-9]{64}$/.test(binding), "Invalid source binding.");
      return {
        id,
        title: text(s.title, 200),
        fileId: text(s.fileId, 100),
        binding,
        before: sideInput(s.before),
        after: sideInput(s.after),
      };
    }),
  };
}
export function parseWalkthroughComparisonNote(
  value: unknown
): WalkthroughComparisonNoteInput {
  need(
    Buffer.byteLength(JSON.stringify(value) ?? "") <= 1024 * 1024,
    "Annotation exceeds 1 MiB."
  );
  const v = object(value);
  keys(v, [
    "walkthroughId",
    "stepId",
    "side",
    "binding",
    "expectedRevision",
    "noteId",
    "body",
    "author",
    "attachments",
    "variableName",
  ]);
  need(v.side === "before" || v.side === "after", "Invalid annotation side.");
  const binding = text(v.binding, 64);
  need(/^[a-f0-9]{64}$/.test(binding), "Invalid annotation binding.");
  return {
    walkthroughId: text(v.walkthroughId, 100),
    stepId: text(v.stepId, 100),
    side: v.side,
    binding,
    expectedRevision: integer(v.expectedRevision),
    body: text(v.body),
    author: text(v.author, 100),
    attachments: parseAttachments(v.attachments),
    ...(v.noteId === undefined ? {} : { noteId: text(v.noteId, 100) }),
    ...(v.variableName === undefined
      ? {}
      : { variableName: text(v.variableName, 200) }),
  };
}
export function comparisonStep(
  saved: SavedComparisonWalkthrough,
  stepId: string
) {
  const step = saved.steps.find((step) => step.id === stepId);
  need(step, "Authored comparison step not found.");
  return step;
}
export function saveWalkthroughNote(
  saved: SavedComparisonWalkthrough,
  input: WalkthroughComparisonNoteInput,
  admitted: AdmittedGitFile
) {
  const step = comparisonStep(saved, input.stepId);
  need(
    input.binding === step.binding &&
      admitted.binding === step.binding &&
      admitted.file.id === step.fileId,
    "Paired source changed. Draft kept; annotations cannot be rebound."
  );
  const source = saved.sources[step.fileId];
  const view = {
    ...admitted,
    scope: step.annotations.scope,
    before: { ...source.before, code: excerpt(source.before, step.before) },
    after: { ...source.after, code: excerpt(source.after, step.after) },
  };
  return saveComparisonNote(step.annotations, view, {
    ...input,
    listId: admitted.listId,
    fileId: admitted.file.id,
  });
}
function excerpt(
  source: AdmittedGitFile["before"],
  meta: SavedComparisonStep["before"]
): SourceCode {
  need(
    source.code && !source.unavailable,
    "Git source unavailable for authored walkthrough."
  );
  const code = source.code;
  const empty = source.content === "";
  need(
    empty
      ? meta.startLine === 0 && meta.endLine === 0
      : meta.startLine >= 1 &&
          meta.endLine >= meta.startLine &&
          meta.endLine <= code.lines.length,
    "Authored range must select exact source lines (empty sides use 0..0)."
  );
  const value = empty
    ? ""
    : code.lines.slice(meta.startLine - 1, meta.endLine).join("\n");
  return {
    ...code,
    startLine: meta.startLine,
    endLine: meta.endLine,
    excerpt: value,
    hash: hash(value),
  };
}
export function authorComparisonWalkthrough(
  input: ComparisonWalkthroughInput,
  query: GitQuery,
  views: AdmittedGitFile[]
): SavedComparisonWalkthrough {
  const id = crypto.randomUUID();
  const sources = Object.fromEntries(views.map((view) => [view.file.id, view]));
  const meta = ({
    title,
    purpose,
    startLine,
    endLine,
    notApplicable,
  }: AuthoredComparisonSide) => ({
    title,
    purpose,
    startLine,
    endLine,
    ...(notApplicable ? { notApplicable } : {}),
  });
  // Build only the small metadata skeleton first. Both budgets are charged
  // incrementally BEFORE appending expanded attachments or cloning any groups.
  const steps: SavedComparisonStep[] = input.steps.map((s) => ({
    id: s.id,
    title: s.title,
    fileId: s.fileId,
    binding: s.binding,
    before: meta(s.before),
    after: meta(s.after),
    annotations: {
      scope: crypto
        .createHash("sha256")
        .update(JSON.stringify([id, s.id, sources[s.fileId]?.scope]))
        .digest("hex"),
      revision: 1,
      notes: [],
    },
  }));
  const content = { id, title: input.title, query, sources, steps };
  const saved = { ...content, sourceSeal: "sha256-v1:" + "0".repeat(64) };
  let expandedSaved = jsonBytes(saved) + 16 * steps.length;
  let expandedView =
    jsonBytes({ id, title: input.title, query, steps: [] }) + 16 * steps.length;
  const check = (pending = 0) => {
    need(
      expandedSaved + pending <= MAX_SAVED_BYTES,
      "Saved authored walkthrough exceeds 2 MiB including archival headroom."
    );
    need(
      expandedView + pending <= MAX_VIEW_BYTES,
      "Expanded authored view exceeds 8 MiB including archival headroom."
    );
  };
  check();
  // Preflight duplicated raw/lines/patch bytes one step at a time, before notes.
  const scopes: ScopeProjection = new Map();
  for (const step of steps) {
    need(
      sources[step.fileId]?.binding === step.binding,
      "Git comparison changed or unavailable; no authored data saved."
    );
    expandedView += jsonBytes(projectStep(saved, step, scopes)) + 1;
    check();
  }
  for (const [index, s] of input.steps.entries()) {
    const source = sources[s.fileId];
    need(
      source && source.binding === s.binding && !source.unavailable,
      "Git comparison changed or unavailable; no authored data saved."
    );
    const result = steps[index];
    const scope = result.annotations.scope;
    for (const side of ["before", "after"] as const) {
      const authored = s[side];
      const code = excerpt(source[side], authored);
      const view = { ...source, scope, [side]: { ...source[side], code } };
      let pendingAttachments = 0;
      const range = (
        first: number,
        last: number,
        start: number,
        end: number
      ): SourceAttachment => {
        need(
          first >= code.startLine &&
            last >= first &&
            last <= code.endLine &&
            start >= 0 &&
            start <= (code.lines[first - 1]?.length ?? -1) &&
            end >= 0 &&
            end <= (code.lines[last - 1]?.length ?? -1),
          "Invalid attachment source range."
        );
        const attachment = {
          file: code.file,
          fileHash: code.fileHash,
          startLine: first,
          endLine: last,
          startColumn: start,
          endColumn: end,
          text: code.lines
            .slice(first - 1, last)
            .map((line, i, all) =>
              line.slice(
                i === 0 ? start : 0,
                i === all.length - 1 ? end : undefined
              )
            )
            .join("\n"),
        };
        pendingAttachments += jsonBytes(attachment) + 1;
        // At most ONE bounded source range is materialized beyond the remaining
        // budget; do not map thousands of ranges into one huge attachment array.
        check(2 * pendingAttachments + 512);
        return attachment;
      };
      const add = (
        body: string,
        attachments: SourceAttachment[],
        variableName?: string
      ) => {
        const single = saveComparisonNote(
          { scope, revision: 1, notes: [] },
          view,
          {
            listId: source.listId,
            fileId: source.file.id,
            binding: s.binding,
            side,
            expectedRevision: 1,
            body,
            author: "Walkthrough author",
            attachments,
            ...(variableName ? { variableName } : {}),
          }
        );
        const note = single.notes[0];
        const bytes = jsonBytes(note) + archivalReserve(note) + 1;
        expandedSaved += bytes;
        expandedView += bytes;
        check();
        result.annotations.notes.push(note);
        result.annotations.revision++;
        pendingAttachments = 0;
      };
      for (const note of authored.notes)
        add(note.body, [
          range(
            note.startLine,
            note.endLine,
            0,
            code.lines[note.endLine - 1]?.length ?? -1
          ),
        ]);
      for (const variable of authored.variables)
        add(
          variable.body,
          variable.occurrences.map((o) =>
            range(
              o.line,
              o.line,
              o.startColumn,
              o.startColumn + variable.name.length
            )
          ),
          variable.name
        );
      need(
        code.excerpt !== "" ||
          authored.notes.length + authored.variables.length === 0,
        "Empty source requires explicit Notes and Variables N/A reasons."
      );
    }
  }
  saved.sourceSeal = sourceSeal(content);
  validateSources(saved);
  assertComparisonBudget(saved);
  return saved;
}
export function readComparisonWalkthrough(
  saved: SavedComparisonWalkthrough
): ComparisonWalkthrough {
  assertComparisonBudget(saved);
  const scopes: ScopeProjection = new Map();
  return structuredClone({
    id: saved.id,
    title: saved.title,
    query: saved.query,
    steps: saved.steps.map((step) => projectStep(saved, step, scopes)),
  });
}
export function validateComparisonWalkthroughs(
  saved: SavedComparisonWalkthrough[] | undefined
) {
  if (saved === undefined) return;
  need(Array.isArray(saved), "Invalid saved comparison walkthroughs.");
  const ids = new Set<string>();
  for (const walk of saved) {
    need(
      typeof walk.id === "string" &&
        !ids.has(walk.id) &&
        Array.isArray(walk.steps) &&
        walk.steps.length > 0 &&
        jsonBytes(walk) <= MAX_SAVED_BYTES,
      "Invalid saved comparison walkthrough."
    );
    ids.add(walk.id);
    validateSources(walk);
    validateComparisonNotes(walk.steps.map((s) => s.annotations));
    readComparisonWalkthrough(walk);
  }
}
