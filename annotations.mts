import crypto from "node:crypto";
import { resolve } from "./indexer.mjs";
import type {
  Note,
  NoteRevision,
  SavedWalkthrough,
  SourceAttachment,
  SourceIndex,
  SourceRef,
  WorkspaceState,
  ResolvedSource,
} from "./types.mjs";

export type AnnotationOperation =
  | "add_reviewed_note"
  | "review_note"
  | "review_explanation"
  | "repair_step_source";
export function isAnnotationOperation(
  name: string
): name is AnnotationOperation {
  return (
    name === "add_reviewed_note" ||
    name === "review_note" ||
    name === "review_explanation" ||
    name === "repair_step_source"
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function text(value: unknown, max = 10000): string {
  need(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    "Text is missing or too long."
  );
  return value.trim();
}
export function parseAttachments(value: unknown): SourceAttachment[] {
  need(
    Array.isArray(value) && value.length <= 40,
    "Invalid source attachments."
  );
  return value.map((range: unknown) => {
    need(object(range), "Invalid source attachment.");
    need(
      typeof range.file === "string" &&
        range.file.length > 0 &&
        range.file.length <= 1000 &&
        !range.file.startsWith("/") &&
        !range.file.includes("\\") &&
        !range.file.split("/").some((part) => part === ".." || part === "."),
      "Invalid attachment file."
    );
    need(
      typeof range.fileHash === "string" &&
        /^[a-f0-9]{20}$/.test(range.fileHash),
      "Invalid attachment fingerprint."
    );
    const { startLine, startColumn, endLine, endColumn } = range;
    need(
      typeof startLine === "number" &&
        Number.isInteger(startLine) &&
        startLine >= 1 &&
        typeof endLine === "number" &&
        Number.isInteger(endLine) &&
        endLine >= startLine &&
        typeof startColumn === "number" &&
        Number.isInteger(startColumn) &&
        startColumn >= 0 &&
        typeof endColumn === "number" &&
        Number.isInteger(endColumn) &&
        endColumn >= 0 &&
        (endLine > startLine || endColumn > startColumn),
      "Invalid attachment range."
    );
    need(
      typeof range.text === "string" &&
        range.text.length > 0 &&
        range.text.length <= 100000,
      "Invalid attachment text."
    );
    need(
      (range.sourceExcerpt === undefined &&
        range.sourceStartLine === undefined) ||
        (typeof range.sourceExcerpt === "string" &&
          range.sourceExcerpt.length <= 100000 &&
          typeof range.sourceStartLine === "number" &&
          Number.isInteger(range.sourceStartLine) &&
          range.sourceStartLine >= 1),
      "Invalid attachment relocation context."
    );
    return {
      file: range.file,
      fileHash: range.fileHash,
      startLine,
      startColumn,
      endLine,
      endColumn,
      text: range.text,
      ...(typeof range.sourceExcerpt === "string" &&
      typeof range.sourceStartLine === "number"
        ? {
            sourceExcerpt: range.sourceExcerpt,
            sourceStartLine: range.sourceStartLine,
          }
        : {}),
    };
  });
}
function selectedText(range: SourceAttachment, lines: string[]): string {
  const selected = lines.slice(range.startLine - 1, range.endLine);
  if (!selected.length) return "";
  selected[selected.length - 1] = selected.at(-1)!.slice(0, range.endColumn);
  selected[0] = selected[0].slice(range.startColumn);
  return selected.join("\n");
}
export function hydrateAttachments(
  ranges: SourceAttachment[] | undefined,
  code: ResolvedSource
): SourceAttachment[] | undefined {
  return ranges?.map((range) => {
    if (
      range.file !== code.file ||
      range.fileHash === code.fileHash ||
      range.sourceExcerpt !== code.excerpt ||
      range.sourceStartLine === undefined
    )
      return range;
    const text = code.lines.join("\n"),
      first = text.indexOf(code.excerpt);
    if (first < 0 || text.indexOf(code.excerpt, first + 1) >= 0) return range;
    const delta = code.startLine - range.sourceStartLine;
    const moved = {
      ...range,
      startLine: range.startLine + delta,
      endLine: range.endLine + delta,
      fileHash: code.fileHash,
      sourceStartLine: code.startLine,
    };
    return selectedText(moved, code.lines) === range.text ? moved : range;
  });
}
export function noteRevision(note: Note): NoteRevision {
  return structuredClone({
    body: note.body,
    author: note.author,
    at: note.at,
    hash: note.hash,
    ...(note.attachments === undefined
      ? {}
      : { attachments: note.attachments }),
    ...(note.variableName === undefined
      ? {}
      : { variableName: note.variableName }),
    ...(note.archived === undefined ? {} : { archived: note.archived }),
  });
}
function validatePresentation(value: {
  variableName?: unknown;
  archived?: unknown;
}) {
  if (value.variableName !== undefined)
    need(
      typeof value.variableName === "string" &&
        /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(
          value.variableName
        ) &&
        value.variableName.length <= 200,
      "Invalid variable name."
    );
  if (value.archived !== undefined)
    need(typeof value.archived === "boolean", "Invalid archived state.");
}
export function validateAnnotationState(state: WorkspaceState) {
  for (const path of state.paths)
    for (const step of path.steps) {
      if (step.explanationAttachments !== undefined)
        parseAttachments(step.explanationAttachments);
      if (step.explanationReviewRequired !== undefined)
        need(
          typeof step.explanationReviewRequired === "boolean",
          "Invalid explanation review state."
        );
      if (step.explanationHistory !== undefined)
        need(
          Array.isArray(step.explanationHistory),
          "Invalid explanation history."
        );
      if (step.explanationAuthor !== undefined)
        need(
          typeof step.explanationAuthor === "string",
          "Invalid explanation author."
        );
      if (step.explanationAt !== undefined)
        need(
          typeof step.explanationAt === "string",
          "Invalid explanation time."
        );
      const revisions = [...(step.explanationHistory ?? [])];
      for (const note of step.notes) {
        validatePresentation(note);
        if (note.attachments !== undefined) parseAttachments(note.attachments);
        if (note.reviewRequired !== undefined)
          need(
            typeof note.reviewRequired === "boolean",
            "Invalid note review state."
          );
        if (note.history !== undefined)
          need(Array.isArray(note.history), "Invalid note history.");
        revisions.push(...(note.history ?? []));
      }
      for (const revision of revisions) {
        need(
          object(revision) &&
            typeof revision.body === "string" &&
            typeof revision.author === "string" &&
            typeof revision.at === "string" &&
            typeof revision.hash === "string",
          "Invalid explanation history."
        );
        validatePresentation({
          variableName: revision.variableName,
          archived: revision.archived,
        });
        if (revision.attachments !== undefined)
          parseAttachments(revision.attachments);
      }
    }
}
function sourceReference(value: unknown): SourceRef {
  need(
    object(value) && typeof value.file === "string",
    "Invalid source reference."
  );
  if (value.symbol !== undefined) {
    need(typeof value.symbol === "string", "Invalid source symbol.");
    return { file: value.file, symbol: value.symbol };
  }
  need(
    typeof value.startLine === "number" && typeof value.endLine === "number",
    "Invalid source range."
  );
  return {
    file: value.file,
    startLine: value.startLine,
    endLine: value.endLine,
  };
}
export function applyAnnotationOperation(
  root: string,
  index: SourceIndex,
  original: SavedWalkthrough,
  operation: AnnotationOperation,
  input: unknown
): { path: SavedWalkthrough; note?: Note } {
  need(object(input), "Invalid review request.");
  need(
    Number.isInteger(input.expectedRevision) &&
      input.expectedRevision === original.revision,
    "Path changed. Review it again before saving."
  );
  const path = structuredClone(original);
  const step = path.steps.find((step) => step.id === input.stepId);
  need(step, "Unknown step.");
  if (operation === "repair_step_source") {
    const source = sourceReference(input.source);
    const code = resolve(root, index, source);
    need(
      typeof input.fileHash === "string" && input.fileHash === code.fileHash,
      "Source changed. Review it again before repairing."
    );
    step.source = source.symbol
      ? source
      : {
          file: code.file,
          startLine: code.startLine,
          endLine: code.endLine,
          excerpt: code.excerpt,
        };
    step.explanationReviewRequired = true;
    step.notes = step.notes.map((note) => ({ ...note, reviewRequired: true }));
    path.revision++;
    return { path };
  }
  const code = resolve(root, index, step.source);
  need(
    input.sourceHash === code.hash && input.fileHash === code.fileHash,
    "Source changed. Review the current source before saving."
  );
  const body = text(input.body),
    author = text(input.author, 100),
    at = new Date().toISOString();
  const attachments = parseAttachments(input.attachments);
  for (const range of attachments) {
    need(
      range.file === code.file && range.fileHash === code.fileHash,
      "Attachment source changed."
    );
    need(
      range.startLine >= code.startLine &&
        range.endLine <= code.endLine &&
        range.startColumn <= code.lines[range.startLine - 1]?.length &&
        range.endColumn <= code.lines[range.endLine - 1]?.length,
      "Attachment is outside the highlighted source."
    );
    need(
      selectedText(range, code.lines) === range.text,
      "Attachment text does not match current source."
    );
    if (code.excerpt.length <= 100000) {
      range.sourceExcerpt = code.excerpt;
      range.sourceStartLine = code.startLine;
    } else {
      delete range.sourceExcerpt;
      delete range.sourceStartLine;
    }
  }
  let note: Note | undefined;
  const existing =
    operation === "review_note"
      ? step.notes.find((item) => item.id === input.noteId)
      : undefined;
  if (operation === "review_note") need(existing, "Note no longer exists.");
  if (operation === "review_explanation")
    need(
      input.variableName === undefined && input.archived === undefined,
      "Presentation fields belong to notes, not card explanations."
    );
  if (input.variableName !== null)
    validatePresentation({ variableName: input.variableName });
  const variableName =
    input.variableName === undefined
      ? existing?.variableName
      : input.variableName === null
        ? undefined
        : text(input.variableName, 200);
  const archived =
    input.archived === undefined ? existing?.archived : input.archived;
  validatePresentation({ variableName, archived });
  if (variableName !== undefined)
    need(
      attachments.length > 0 &&
        attachments.every((range) => {
          const line = code.lines[range.startLine - 1];
          const before =
            Array.from(line.slice(0, range.startColumn)).at(-1) ?? "";
          const after = Array.from(line.slice(range.endColumn))[0] ?? "";
          const identifierPart = /^[$_\u200C\u200D\p{ID_Continue}]$/u;
          return (
            range.text === variableName &&
            !identifierPart.test(before) &&
            !identifierPart.test(after)
          );
        }),
      "A variable explanation needs explicit attachments selecting its whole variable name."
    );
  if (operation === "review_explanation") {
    step.explanationHistory = [
      ...(step.explanationHistory ?? []),
      {
        body: step.explanation,
        author: step.explanationAuthor ?? "Unknown original author",
        at: step.explanationAt ?? "",
        hash: step.snapshotHash,
        ...(step.explanationAttachments
          ? { attachments: step.explanationAttachments }
          : {}),
      },
    ];
    step.explanation = body;
    step.explanationAuthor = author;
    step.explanationAt = at;
    step.explanationAttachments = attachments;
    step.snapshotHash = code.hash;
    step.explanationReviewRequired = false;
  } else if (operation === "review_note") {
    note = step.notes.find((note) => note.id === input.noteId);
    need(note, "Note no longer exists.");
    note.history = [...(note.history ?? []), noteRevision(note)];
    Object.assign(note, {
      body,
      author,
      at,
      hash: code.hash,
      attachments,
      reviewRequired: false,
    });
  } else {
    need(operation === "add_reviewed_note", "Unknown annotation operation.");
    note = {
      id: crypto.randomUUID(),
      body,
      author,
      at,
      hash: code.hash,
      attachments,
    };
    step.notes.push(note);
  }
  if (note) {
    if (variableName === undefined) delete note.variableName;
    else note.variableName = variableName;
    if (typeof archived === "boolean") note.archived = archived;
  }
  path.revision++;
  return { path, note };
}
