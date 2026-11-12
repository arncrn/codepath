import crypto from "node:crypto";
import { parseAttachments, noteRevision } from "./annotations.mjs";
import {
  currentSourceAttachment,
  wholeIdentifierAttachment,
} from "./source-bindings.mjs";
import type {
  ComparisonNotes,
  ComparisonNoteInput,
  GitFileView,
} from "./types.mjs";
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
const binding = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validateComparisonNotes(groups: ComparisonNotes[] | undefined) {
  if (groups === undefined) return;
  need(Array.isArray(groups), "Invalid comparison annotations.");
  const scopes = new Set<string>();
  for (const group of groups) {
    need(
      binding(group.scope) &&
        !scopes.has(group.scope) &&
        Number.isInteger(group.revision) &&
        group.revision >= 1 &&
        Array.isArray(group.notes),
      "Invalid comparison note scope/revision."
    );
    scopes.add(group.scope);
    const ids = new Set<string>();
    for (const note of group.notes) {
      need(
        typeof note.id === "string" && !ids.has(note.id),
        "Invalid comparison note identity."
      );
      ids.add(note.id);
      need(
        note.history === undefined || Array.isArray(note.history),
        "Invalid comparison note history."
      );
      for (const version of [note, ...(note.history ?? [])]) {
        need(
          binding(version.binding) &&
            ["before", "after"].includes(version.side) &&
            typeof version.body === "string" &&
            typeof version.author === "string" &&
            typeof version.at === "string" &&
            typeof version.hash === "string",
          "Invalid comparison annotation binding."
        );
        need(
          version.archived === undefined ||
            typeof version.archived === "boolean",
          "Invalid comparison note state."
        );
        if (version.attachments !== undefined)
          parseAttachments(version.attachments);
      }
    }
  }
}
export function readComparisonNotes(
  groups: ComparisonNotes[] | undefined,
  scope: string,
  currentBinding: string
): ComparisonNotes {
  const group = structuredClone(
    groups?.find((group) => group.scope === scope) ?? {
      scope,
      revision: 0,
      notes: [],
    }
  );
  for (const note of group.notes) note.stale = note.binding !== currentBinding;
  return group;
}
function current(
  original: ComparisonNotes | undefined,
  scope: string,
  expectedRevision: number
) {
  need(
    Number.isInteger(expectedRevision) &&
      expectedRevision === (original?.revision ?? 0),
    "Annotations changed. Read the latest notes before saving; your draft is kept."
  );
  return structuredClone(original ?? { scope, revision: 0, notes: [] });
}
export function saveComparisonNote(
  original: ComparisonNotes | undefined,
  view: Omit<GitFileView, "annotations">,
  input: ComparisonNoteInput
): ComparisonNotes {
  need(
    input.binding === view.binding && ["before", "after"].includes(input.side),
    "Comparison changed. Refresh before saving; draft kept."
  );
  const group = current(original, view.scope, input.expectedRevision);
  const code = view[input.side].code;
  need(
    code && !view[input.side].unavailable,
    "This source side is unavailable for annotation."
  );
  need(
    typeof input.body === "string" &&
      input.body.trim().length > 0 &&
      input.body.length <= 10000 &&
      typeof input.author === "string" &&
      input.author.trim().length > 0 &&
      input.author.length <= 100,
    "Note text is missing or too long."
  );
  const attachments = parseAttachments(input.attachments);
  need(
    attachments.every((range) => currentSourceAttachment(range, code)),
    "Attachment does not match this exact source side."
  );
  if (input.variableName !== undefined)
    need(
      typeof input.variableName === "string" &&
        input.variableName.length <= 200 &&
        /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(
          input.variableName
        ) &&
        attachments.length > 0 &&
        attachments.every((range) =>
          wholeIdentifierAttachment(range, input.variableName!, code)
        ),
      "Variable attachments must select the whole identifier."
    );
  const existing =
    input.noteId === undefined
      ? undefined
      : group.notes.find((note) => note.id === input.noteId);
  if (input.noteId !== undefined)
    need(
      existing &&
        !existing.archived &&
        existing.binding === view.binding &&
        existing.side === input.side,
      "Note belongs to a different or stale source; it cannot be rebound. Create a new annotation or delete the old entry."
    );
  const next = {
    id: existing?.id ?? crypto.randomUUID(),
    body: input.body.trim(),
    author: input.author.trim(),
    at: new Date().toISOString(),
    hash: code.hash,
    binding: view.binding,
    side: input.side,
    attachments,
    ...(input.variableName ? { variableName: input.variableName } : {}),
    ...(existing
      ? {
          history: [
            ...(existing.history ?? []),
            {
              ...noteRevision(existing),
              binding: existing.binding,
              side: existing.side,
            },
          ],
        }
      : {}),
  };
  if (existing) group.notes[group.notes.indexOf(existing)] = next;
  else group.notes.push(next);
  group.revision++;
  return group;
}
export function deleteComparisonNote(
  original: ComparisonNotes | undefined,
  input: { scope: string; noteId: string; expectedRevision: number }
): ComparisonNotes {
  need(original, "Comparison note scope not found.");
  const group = current(original, input.scope, input.expectedRevision);
  const note = group.notes.find(
    (note) => note.id === input.noteId && !note.archived
  );
  need(note, "Active note not found in this comparison scope.");
  note.history = [
    ...(note.history ?? []),
    { ...noteRevision(note), binding: note.binding, side: note.side },
  ];
  note.archived = true;
  group.revision++;
  return group;
}
