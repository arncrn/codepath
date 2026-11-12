import type { SourceAttachment, Step } from "../types.mjs";
import { currentSourceAttachment } from "../source-bindings.mjs";

export interface BlockNote {
  id: string;
  color: string;
  tint: string;
  ranges: SourceAttachment[];
}

function currentRange(step: Step, range: SourceAttachment): boolean {
  return (
    !!step.code && !step.error && currentSourceAttachment(range, step.code)
  );
}

export function attachedBlockNotes(step: Step): BlockNote[] {
  if (!step.code || step.error) return [];
  // Include archived/stale block notes in the ordinal so their visibility does
  // not recolor other notes. New notes append; no presentation data is saved.
  return step.notes
    .filter((note) => !note.variableName)
    .flatMap((note, index) => {
      if (note.archived || note.stale) return [];
      const ranges = (note.attachments ?? []).filter((range) =>
        currentRange(step, range)
      );
      // Blue, teal, amber and violet only. Red/pink is reserved for deletions.
      const hue = [210, 174, 42, 260, 194, 156, 52, 242][index % 8];
      return ranges.length
        ? [
            {
              id: note.id,
              color: `hsl(${hue} 65% 58%)`,
              tint: `hsl(${hue} 65% 58% / 0.12)`,
              ranges,
            },
          ]
        : [];
    });
}

export function lastBlockLine(range: SourceAttachment): number {
  return range.endColumn === 0 && range.endLine > range.startLine
    ? range.endLine - 1
    : range.endLine;
}

export function blocksOnLine(notes: BlockNote[], line: number): BlockNote[] {
  return notes.filter((note) =>
    note.ranges.some(
      (range) => line >= range.startLine && line <= lastBlockLine(range)
    )
  );
}

export function blockLineLabel(ranges: SourceAttachment[]): string {
  return (
    "Lines " +
    ranges
      .map((range) =>
        range.startLine === lastBlockLine(range)
          ? String(range.startLine)
          : `${range.startLine}–${lastBlockLine(range)}`
      )
      .join(", ")
  );
}

export function wholeLineBlock(
  step: Step,
  selected: SourceAttachment
): SourceAttachment | null {
  if (!currentRange(step, selected) || !step.code) return null;
  const endLine = lastBlockLine(selected);
  const text = step.code.lines
    .slice(selected.startLine - 1, endLine)
    .join("\n");
  if (!text) return null;
  return {
    file: step.code.file,
    fileHash: step.code.fileHash,
    startLine: selected.startLine,
    startColumn: 0,
    endLine,
    endColumn: step.code.lines[endLine - 1].length,
    text,
  };
}
