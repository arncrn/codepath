import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";
import type { SourceSymbol, CallSite, FunctionScopes } from "./types.mjs";
import { javascriptFunctionScopes } from "./source-functions.mjs";
export const hash = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex").slice(0, 20);
export const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".go",
]);
export const ignoredDirectories = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "out",
]);
export function read(root: string, file: string) {
  root = fs.realpathSync(root);
  if (
    typeof file !== "string" ||
    path.isAbsolute(file) ||
    file.split(/[\\/]/).some((p) => p === ".." || p.startsWith("."))
  )
    throw Error("Use a relative source filename inside this project.");
  const target = fs.realpathSync(path.join(root, file));
  if (
    !target.startsWith(root + path.sep) ||
    !sourceExtensions.has(path.extname(target))
  )
    throw Error("Not a project source file.");
  if (fs.statSync(target).size > 1024 * 1024)
    throw Error("File exceeds 1 MiB.");
  return fs.readFileSync(target, "utf8");
}
export function mask(text: string) {
  let out = "",
    quote = "",
    block = false,
    line = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      n = text[i + 1];
    if (line) {
      if (c === "\n") line = false;
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (block) {
      if (c === "*" && n === "/") {
        out += "  ";
        i++;
        block = false;
      } else out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      if (c === "\\" && quote !== String.fromCharCode(96)) {
        out += "  ";
        i++;
      } else {
        if (c === quote) quote = "";
        out += c === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (c === "/" && n === "/") {
      line = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      block = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c.charCodeAt(0) === 96) {
      quote = c;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}
export function parseSource(file: string, text: string) {
  return ts.createSourceFile(
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
}
export function callsIn(source: ts.SourceFile, node: ts.Node = source) {
  const calls: CallSite[] = [];
  const scan = (n: ts.Node) => {
    if (ts.isCallExpression(n))
      calls.push({
        name: n.expression.getText(source),
        line: source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1,
      });
    ts.forEachChild(n, scan);
  };
  scan(node);
  return calls;
}
export function parseFile(file: string, text: string) {
  const list: SourceSymbol[] = [],
    line = (p: number) => text.slice(0, p).split("\n").length;
  if (file.endsWith(".go")) {
    const clean = mask(text);
    const functionScopes: FunctionScopes = { functions: [], reliable: true };
    for (const m of clean.matchAll(
      /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g
    )) {
      const open = clean.indexOf("{", m.index);
      if (open < 0) continue;
      let depth = 1,
        end = open + 1;
      for (; end < clean.length && depth; end++) {
        if (clean[end] === "{") depth++;
        if (clean[end] === "}") depth--;
      }
      // Context supports only simple, balanced named Go functions/methods.
      // The existing navigation index remains approximate. In particular its
      // first-brace search is not safe for interface/struct return types.
      const signature = clean.slice(m.index, open + 1);
      const simple =
        /^func\s+(?:\(\s*(?:\w+\s+)?\*?(\w+)\s*\)\s*)?\w+\s*\([\w\s,.*\[\]]*\)\s*(?:\*?[\w.\[\]]+|\([\w\s,.*\[\]]*\))?\s*\{$/.exec(
          signature
        );
      if (!simple || depth || /\b(?:interface|struct)\b/.test(signature))
        functionScopes.reliable = false;
      functionScopes.functions.push({
        name: (simple?.[1] ? simple[1] + "." : "") + m[1],
        start: m.index,
        end,
        startLine: line(m.index),
        startColumn: m.index - (text.lastIndexOf("\n", m.index - 1) + 1),
      });
      const calls = [
        ...clean
          .slice(open, end)
          .matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/g),
      ].map((c) => ({ name: c[1], line: line(open + c.index) }));
      list.push({
        file,
        name: m[1],
        startLine: line(m.index),
        endLine: line(end),
        calls,
        approximate: true,
      });
    }
    // Unmatched func tokens include literals, function types and generics.
    // A conservative file-wide unknown avoids assigning their bodies to an
    // outer function. This is intentionally not a second Go parser.
    if (
      [...clean.matchAll(/\bfunc\b/g)].length !==
      functionScopes.functions.length
    )
      functionScopes.reliable = false;
    return {
      symbols: list,
      calls: list.flatMap((s) => s.calls),
      functionScopes,
    };
  }
  const source = parseSource(file, text);
  const add = (node: ts.Node, name: string) => {
    list.push({
      file,
      name,
      startLine: line(node.getStart(source)),
      endLine: line(node.end),
      calls: callsIn(source, node),
    });
  };
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.body)
      add(n, n.name?.text || "default");
    else if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    )
      add(n, n.name.getText(source));
    else if (ts.isMethodDeclaration(n) && n.body)
      add(
        n,
        ("name" in n.parent && n.parent.name
          ? (n.parent.name as ts.Node).getText(source) + "."
          : "") + n.name.getText(source)
      );
    else if (
      ts.isCallExpression(n) &&
      /^(test|it|describe)(\..+)?$/.test(n.expression.getText(source)) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    )
      add(n, n.expression.getText(source) + ": " + n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(source);
  return {
    symbols: list,
    calls: callsIn(source),
    functionScopes: javascriptFunctionScopes(source),
  };
}
