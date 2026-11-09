import type { SourceAttachment, Step } from "../types.mjs";

export interface AttachedExplanation {
  id: string;
  ranges: SourceAttachment[];
}
export function attachedExplanations(step: Step): AttachedExplanation[] {
  if (!step.code || step.error) return [];
  const file = step.code.file,
    fileHash = step.code.fileHash;
  const current = (ranges: SourceAttachment[] = []) =>
    ranges.filter(
      (range) => range.file === file && range.fileHash === fileHash
    );
  return step.notes
    .filter((note) => note.variableName && !note.archived && !note.stale)
    .map((note) => ({
      id: note.id,
      ranges: current(note.attachments).filter(
        (range) => range.text === note.variableName
      ),
    }))
    .filter((explanation) => explanation.ranges.length > 0);
}
export function lineMatches(
  explanations: AttachedExplanation[],
  line: number,
  start: number,
  end: number
) {
  return explanations.filter((explanation) =>
    explanation.ranges.some(
      (range) =>
        line >= range.startLine &&
        line <= range.endLine &&
        start < (line === range.endLine ? range.endColumn : Infinity) &&
        end > (line === range.startLine ? range.startColumn : 0)
    )
  );
}
export function selectedSourceRange(
  container: HTMLElement,
  step: Step
): SourceAttachment | null {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount ||
    !step.code
  )
    return null;
  const range = selection.getRangeAt(0);
  function position(node: Node, offset: number) {
    const element = node instanceof Element ? node : node.parentElement;
    const code = element?.closest<HTMLElement>("code[data-source-line]");
    if (!code || !container.contains(code)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(code);
    prefix.setEnd(node, offset);
    return {
      line: Number(code.dataset.sourceLine),
      column: prefix.toString().length,
    };
  }
  const start = position(range.startContainer, range.startOffset),
    end = position(range.endContainer, range.endOffset);
  if (
    !start ||
    !end ||
    start.line < step.code.startLine ||
    end.line > step.code.endLine
  )
    return null;
  const lines = step.code.lines.slice(start.line - 1, end.line);
  lines[lines.length - 1] = lines.at(-1)!.slice(0, end.column);
  lines[0] = lines[0].slice(start.column);
  const text = lines.join("\n");
  return text
    ? {
        file: step.code.file,
        fileHash: step.code.fileHash,
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
        text,
      }
    : null;
}
