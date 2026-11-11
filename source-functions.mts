import ts from "typescript";
import type { FunctionScopes, FunctionContext } from "./types.mjs";

// These are lexical source identities, not callable symbols or a runtime stack.
// Use the AST already parsed for this cached file, including unnamed functions.
export function javascriptFunctionScopes(
  source: ts.SourceFile
): FunctionScopes {
  const functions: FunctionScopes["functions"] = [];
  function visit(node: ts.Node, scope: string[]) {
    let next = scope;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
      next = [...scope, node.name?.text ?? "anonymous class"];
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const parent = node.parent;
      let name =
        "name" in node && node.name
          ? node.name.getText(source)
          : ts.isConstructorDeclaration(node)
            ? "constructor"
            : "anonymous";
      let extent: ts.Node = node;
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        (ts.isVariableDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent))
      ) {
        const binding = parent.name.getText(source);
        name = name === "anonymous" ? binding : `${binding} (${name})`;
        extent = parent;
        if (
          ts.isVariableDeclaration(parent) &&
          ts.isVariableDeclarationList(parent.parent) &&
          parent.parent.declarations.length === 1 &&
          ts.isVariableStatement(parent.parent.parent)
        )
          extent = parent.parent.parent;
      }
      const start = extent.getStart(source);
      const position = source.getLineAndCharacterOfPosition(
        node.getStart(source)
      );
      next = [...scope, name];
      functions.push({
        name: next.join(" › "),
        start,
        end: extent.end,
        startLine: position.line + 1,
        startColumn: position.character,
      });
    }
    ts.forEachChild(node, (child) => visit(child, next));
  }
  visit(source, []);
  // TypeScript's parser recovers from malformed input. Do not report recovered
  // shapes as precise current function context.
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  return { functions, reliable: !diagnostics?.length };
}

export function functionContext(
  scopes: FunctionScopes | undefined,
  text: string,
  startLine: number,
  endLine: number
): FunctionContext {
  if (!scopes?.reliable)
    return { status: "unknown", reason: "unsupported or invalid source" };
  const lines = text.split("\n");
  const offset = lines
    .slice(0, startLine - 1)
    .reduce((n, line) => n + line.length + 1, 0);
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  const start = offset + selected.length - selected.trimStart().length;
  const end = offset + selected.trimEnd().length;
  if (end <= start) return { status: "unknown", reason: "empty selection" };
  const overlapping = scopes.functions.filter(
    (fn) => fn.start < end && fn.end > start
  );
  const containing = overlapping
    .filter((fn) => fn.start <= start && fn.end >= end)
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  const fn = containing[0];
  // The smallest common containing function owns the selected range, even
  // when a partial selection includes nested callbacks. With no common owner,
  // overlapping sibling functions remain genuinely mixed.
  if (fn)
    return {
      status: "function",
      name: fn.name,
      startLine: fn.startLine,
      startColumn: fn.startColumn,
    };
  return { status: overlapping.length ? "multiple" : "no-function" };
}
