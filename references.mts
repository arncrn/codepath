import path from "node:path";
import ts from "typescript";
import type { SourceIndex, Position, ReferenceResult } from "./types.mjs";
import { read, hash, mask, sourceFile } from "./indexer.mjs";

// Resolve one clicked identifier, not all calls in its containing function.
// This fallback deliberately does not claim type/import/receiver resolution.
export function resolveReference(
  root: string,
  index: SourceIndex,
  {
    file,
    line,
    column,
    cursor,
    identifyOnly,
  }: Position & { cursor?: string; identifyOnly?: boolean }
): ReferenceResult {
  sourceFile(index, file);
  const text = read(root, file),
    lines = text.split("\n");
  if (
    !Number.isInteger(line) ||
    !Number.isInteger(column) ||
    line < 1 ||
    line > lines.length ||
    column < 0 ||
    column >= lines[line - 1].length
  )
    throw Error("Invalid source position.");
  const offset =
    lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0) + column;
  let name: string | undefined;
  const go = file.endsWith(".go");
  if (go) {
    for (const match of mask(text).matchAll(/[A-Za-z_]\w*/g)) {
      if (match.index <= offset && offset < match.index + match[0].length) {
        name = match[0];
        break;
      }
    }
  } else {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      /\.[jt]sx$/.test(file)
        ? ts.ScriptKind.TSX
        : /\.[cm]?ts$/.test(file)
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS
    );
    const visit = (node: ts.Node) => {
      if (node.getFullStart() > offset || node.end <= offset) return;
      if (ts.isIdentifier(node) && node.getStart(source) <= offset) {
        name = node.text;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (!name)
    throw Error(
      "Click a source identifier, not a string, comment or punctuation."
    );
  const local = sourceFile(index, file, text).symbols.filter(
    (s) => s.name === name || s.name.endsWith("." + name)
  );
  const page =
    !identifyOnly && (go || !local.length)
      ? index.querySymbols?.(
          [name],
          cursor,
          go ? path.posix.dirname(file) : undefined
        )
      : undefined;
  let candidates = identifyOnly
    ? []
    : !go && local.length
      ? local
      : page
        ? page.symbols
        : index.files.flatMap((f) => f.symbols);
  candidates = candidates.filter(
    (s) =>
      (s.name === name || s.name.endsWith("." + name)) &&
      (go
        ? s.file.endsWith(".go") &&
          path.posix.dirname(s.file) === path.posix.dirname(file)
        : !s.file.endsWith(".go"))
  );
  if (go) {
    const pkg = mask(text).match(/\bpackage\s+(\w+)/)?.[1];
    candidates = candidates.filter(
      (s) =>
        pkg && mask(read(root, s.file)).match(/\bpackage\s+(\w+)/)?.[1] === pkg
    );
  }
  return {
    name,
    fileHash: hash(text),
    complete: page?.complete ?? true,
    ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    candidates: candidates.map((s) => ({
      ...s,
      evidence: "inferred",
      reason:
        (go ? "Same-package" : "Project") +
        " name match for " +
        name +
        " at " +
        file +
        ":" +
        line +
        ". Not a resolved definition or execution trace.",
    })),
    limitation:
      "Name-based fallback only. VS Code language definitions, when available, take precedence in the extension.",
  };
}
