import type { ResolvedSource, SourceAttachment } from "./types.mjs";

// The saved range must identify exact text in the currently displayed card.
export function currentSourceAttachment(
  range: SourceAttachment,
  code: ResolvedSource
): boolean {
  if (
    range.file !== code.file ||
    range.fileHash !== code.fileHash ||
    ![range.startLine, range.endLine, range.startColumn, range.endColumn].every(
      Number.isInteger
    ) ||
    range.startLine < code.startLine ||
    range.endLine > code.endLine ||
    range.endLine < range.startLine ||
    range.startColumn < 0 ||
    range.endColumn < 0 ||
    (range.startLine === range.endLine &&
      range.endColumn <= range.startColumn) ||
    range.startColumn > (code.lines[range.startLine - 1]?.length ?? -1) ||
    range.endColumn > (code.lines[range.endLine - 1]?.length ?? -1) ||
    !range.text.length
  )
    return false;
  const lines = code.lines.slice(range.startLine - 1, range.endLine);
  if (!lines.length) return false;
  lines[lines.length - 1] = lines.at(-1)!.slice(0, range.endColumn);
  lines[0] = lines[0].slice(range.startColumn);
  return lines.join("\n") === range.text;
}
export function wholeIdentifierAttachment(
  range: SourceAttachment,
  name: string,
  code: ResolvedSource
): boolean {
  if (
    !currentSourceAttachment(range, code) ||
    range.startLine !== range.endLine ||
    range.text !== name
  )
    return false;
  const line = code.lines[range.startLine - 1];
  const before = Array.from(line.slice(0, range.startColumn)).at(-1) ?? "";
  const after = Array.from(line.slice(range.endColumn))[0] ?? "";
  const identifierPart = /^[$_\u200C\u200D\p{ID_Continue}]$/u;
  return !identifierPart.test(before) && !identifierPart.test(after);
}
