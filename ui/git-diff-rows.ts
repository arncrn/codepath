import type { GitFileView } from "../types.mjs";

export interface DiffRows {
  before: (number | null)[];
  after: (number | null)[];
  removed: Set<number>;
  added: Set<number>;
}
// Git's lines exclude the synthetic empty element after a terminal LF. Keep CR
// and BOM exactly: a normalized patch is not an index into different raw bytes.
export function rawLineNumbers(content: string) {
  const count =
    content === ""
      ? 0
      : content.split("\n").length - Number(content.endsWith("\n"));
  return Array.from({ length: count }, (_, i) => i + 1);
}
export function diffRows(
  view: Pick<
    GitFileView,
    "before" | "after" | "patch" | "patchMatchesRaw" | "unavailable"
  >
): DiffRows | null {
  if (
    view.unavailable ||
    !view.patchMatchesRaw?.before ||
    !view.patchMatchesRaw.after ||
    view.before.content === undefined ||
    view.after.content === undefined
  )
    return null;
  const left = view.before.content.split("\n"),
    right = view.after.content.split("\n");
  const n = rawLineNumbers(view.before.content).length,
    m = rawLineNumbers(view.after.content).length;
  const rows: DiffRows = {
    before: [],
    after: [],
    removed: new Set(),
    added: new Set(),
  };
  let a = 1,
    b = 1;
  function row(x: number | null, y: number | null) {
    rows.before.push(x);
    rows.after.push(y);
  }
  function context(untilA: number, untilB: number) {
    if (
      untilA - a !== untilB - b ||
      untilA > n + 1 ||
      untilB > m + 1 ||
      untilA < a ||
      untilB < b
    )
      return false;
    while (a < untilA) {
      if (left[a - 1] !== right[b - 1]) return false;
      row(a++, b++);
    }
    return true;
  }
  const lines = view.patch.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!h) continue;
    found = true;
    const ac = Number(h[2] ?? 1),
      bc = Number(h[4] ?? 1);
    const as = Number(h[1]) + Number(ac === 0),
      bs = Number(h[3]) + Number(bc === 0);
    if (!context(as, bs)) return null;
    const endA = as + ac,
      endB = bs + bc;
    const removed: number[] = [],
      added: number[] = [];
    const flush = () => {
      for (let j = 0; j < Math.max(removed.length, added.length); j++)
        row(removed[j] ?? null, added[j] ?? null);
      removed.length = added.length = 0;
    };
    for (i++; i < lines.length && !lines[i].startsWith("@@ "); i++) {
      const text = lines[i];
      if (text.startsWith("\\ No newline at end of file")) continue;
      if (!text && i === lines.length - 1) break;
      if (text.startsWith("-")) {
        if (a >= endA || left[a - 1] !== text.slice(1)) return null;
        rows.removed.add(a);
        removed.push(a++);
      } else if (text.startsWith("+")) {
        if (b >= endB || right[b - 1] !== text.slice(1)) return null;
        rows.added.add(b);
        added.push(b++);
      } else if (text.startsWith(" ")) {
        flush();
        if (
          a >= endA ||
          b >= endB ||
          left[a - 1] !== text.slice(1) ||
          right[b - 1] !== text.slice(1)
        )
          return null;
        row(a++, b++);
      } else return null;
    }
    flush();
    if (a !== endA || b !== endB) return null;
    i--;
  }
  if (!found && view.before.content !== view.after.content) return null;
  return context(n + 1, m + 1) ? rows : null;
}
// Selected authored windows never expand the space between unrelated excerpts.
// Keep only rows containing selected source. Disconnected windows fall back
// explicitly to independent excerpts rather than padding hundreds of fake rows.
export function excerptRows(
  rows: DiffRows,
  before: { startLine: number; endLine: number },
  after: { startLine: number; endLine: number }
) {
  const result: DiffRows = {
    before: [],
    after: [],
    removed: rows.removed,
    added: rows.added,
  };
  let previous = -1,
    corresponding = false;
  for (let i = 0; i < rows.before.length; i++) {
    const a = rows.before[i],
      b = rows.after[i];
    const inA = a !== null && a >= before.startLine && a <= before.endLine;
    const inB = b !== null && b >= after.startLine && b <= after.endLine;
    if (!inA && !inB) continue;
    if (previous >= 0 && i > previous + 1) return null;
    corresponding ||= inA && inB;
    result.before.push(inA ? a : null);
    result.after.push(inB ? b : null);
    previous = i;
  }
  return !corresponding && before.startLine > 0 && after.startLine > 0
    ? null
    : result;
}

export type DisplayDiffRow =
  | number
  | null
  | "omitted"
  | { startLine: number | null; endLine: number | null };
export interface FocusedDiffRows extends Omit<DiffRows, "before" | "after"> {
  before: DisplayDiffRow[];
  after: DisplayDiffRow[];
}
// Focus is a display choice, not authored content. Only verified raw alignment
// enters here. Keep every change plus three real aligned context rows; merging
// windows and copying selected rows are linear, even for thousands of hunks.
export function focusedRows(
  rows: DiffRows,
  reveal?: { side: "before" | "after"; startLine: number; endLine: number }
): FocusedDiffRows {
  const windows: { start: number; end: number }[] = [];
  for (let i = 0; i < rows.before.length; i++) {
    const a = rows.before[i],
      b = rows.after[i];
    if (
      !(a !== null && rows.removed.has(a)) &&
      !(b !== null && rows.added.has(b)) &&
      !(
        reveal &&
        rows[reveal.side][i] !== null &&
        rows[reveal.side][i]! >= reveal.startLine &&
        rows[reveal.side][i]! <= reveal.endLine
      )
    )
      continue;
    const start = Math.max(0, i - 3),
      end = Math.min(rows.before.length, i + 4);
    const last = windows.at(-1);
    if (last && start <= last.end) last.end = end;
    else windows.push({ start, end });
  }
  const result: FocusedDiffRows = {
    before: [],
    after: [],
    removed: rows.removed,
    added: rows.added,
  };
  if (!windows.length) return result;
  let next = 0;
  function omission() {
    result.before.push("omitted");
    result.after.push("omitted");
  }
  for (const { start, end } of windows) {
    if (start > next) omission();
    for (const side of ["before", "after"] as const) {
      const lines = rows[side]
        .slice(start, end)
        .filter((line): line is number => line !== null);
      result[side].push({
        startLine: lines[0] ?? null,
        endLine: lines.at(-1) ?? null,
      });
    }
    for (let i = start; i < end; i++) {
      result.before.push(rows.before[i]);
      result.after.push(rows.after[i]);
    }
    next = end;
  }
  if (next < rows.before.length) omission();
  return result;
}
