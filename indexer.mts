import { read, hash, callsIn, parseSource } from "./source-parser.mjs";
import { createSourceProject } from "./source-project.mjs";
import type {
  SourceRef,
  SourceIndex,
  SourceSymbol,
  CallSite,
} from "./types.mjs";
export { read, hash, mask } from "./source-parser.mjs";

// Compatibility for in-process callers needing a complete file catalog. Source
// details remain lazy; production owns one persistent project instead.
export function indexProject(root: string): SourceIndex {
  const project = createSourceProject(root);
  project.discoverAll();
  return project.index;
}
export function sourceFile(
  index: SourceIndex,
  file: string,
  currentText?: string
) {
  const entry = index.loadFile
    ? index.loadFile(file, currentText)
    : index.files.find((f) => f.file === file);
  if (!entry) throw Error("File is not indexed: " + file);
  return entry;
}
export function resolve(root: string, index: SourceIndex, ref: SourceRef) {
  sourceFile(index, ref.file); // Eligibility is independent of discovery order.
  const text = read(root, ref.file),
    lines = text.split("\n");
  const entry = sourceFile(index, ref.file, text);
  let { startLine, endLine } = ref;
  if (ref.symbol) {
    const matches = entry.symbols.filter((s) => s.name === ref.symbol);
    if (matches.length !== 1)
      throw Error(
        "Missing or ambiguous symbol " +
          ref.symbol +
          ". Choose exact lines instead."
      );
    ({ startLine, endLine } = matches[0]);
  } else if (ref.excerpt) {
    const offset = text.indexOf(ref.excerpt);
    if (offset >= 0 && text.indexOf(ref.excerpt, offset + 1) < 0) {
      startLine = text.slice(0, offset).split("\n").length;
      endLine = startLine + ref.excerpt.split("\n").length - 1;
    }
  }
  if (
    startLine === undefined ||
    endLine === undefined ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  )
    throw Error("Invalid line range.");
  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  return {
    file: ref.file,
    symbol: ref.symbol,
    startLine,
    endLine,
    excerpt,
    hash: hash(excerpt),
    fileHash: hash(text),
    lines,
  };
}
export function follow(
  root: string,
  index: SourceIndex,
  ref: SourceRef,
  cursor?: string
) {
  const code = resolve(root, index, ref);
  const entry = sourceFile(index, ref.file);
  const fileCalls =
    entry.calls ??
    (ref.file.endsWith(".go")
      ? entry.symbols.flatMap((s) => s.calls)
      : callsIn(parseSource(ref.file, code.lines.join("\n"))));
  const calls = fileCalls.filter(
    (c) => c.line >= code.startLine && c.line <= code.endLine
  );
  const names = [
    ...new Set(calls.flatMap((c) => [c.name, c.name.split(".").at(-1)!])),
  ];
  if (!calls.length)
    return {
      candidates: [],
      calls,
      unresolved: [],
      complete: true,
      limitation: "No calls in this selection. Not an execution trace.",
    };
  const page = index.querySymbols?.(names, cursor, undefined, {
    file: ref.file,
    startLine: code.startLine,
  });
  const all = page ? page.symbols : index.files.flatMap((f) => f.symbols);
  const candidates: SourceSymbol[] = [],
    unresolved: CallSite[] = [];
  for (const call of calls) {
    const leaf = call.name.split(".").at(-1);
    const targets = all
      .filter(
        (s) =>
          s.name === call.name || s.name === leaf || s.name.endsWith("." + leaf)
      )
      .filter((s) => s.file !== ref.file || s.startLine !== code.startLine);
    const matched = page?.matchedNames?.some(
      (name) => name === call.name || name === leaf || name.endsWith("." + leaf)
    );
    if (page ? page.complete && !matched : !targets.length)
      unresolved.push(call);
    for (const target of targets)
      if (
        !candidates.some(
          (c) => c.file === target.file && c.startLine === target.startLine
        )
      )
        candidates.push({
          ...target,
          reason:
            "Name match for " +
            call.name +
            "() at " +
            ref.file +
            ":" +
            call.line +
            ". Check imports and dispatch.",
        });
  }
  return {
    candidates,
    calls,
    unresolved,
    unresolvedComplete: page?.complete ?? true,
    complete: page?.complete ?? true,
    ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    limitation:
      "Name matches, not a resolved call graph or execution trace. Imports, aliases, HTTP and async edges may need explicit connections. Continue nextCursor until complete before treating the search as exhaustive.",
  };
}
