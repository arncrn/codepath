/*!
 * Refractor 5.0.0 and its bundled MIT-licensed dependencies.
 * Copyright (c) Titus Wormer <tituswormer@gmail.com>
 * Copyright (c) Lea Verou
 * Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
 * Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
 * Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * 'Software'), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { refractor } from "refractor/core";
import go from "refractor/go";
import tsx from "refractor/tsx";
import type { RootContent } from "hast";

refractor.register(tsx);
refractor.register(go);

export type SyntaxKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "boolean"
  | "function"
  | "type"
  | "tag"
  | "attribute"
  | "operator"
  | "punctuation";

export interface SyntaxRun {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly kind: SyntaxKind;
}

const languages: Readonly<Record<string, string>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  go: "go",
};
const kinds: Readonly<Record<string, SyntaxKind>> = {
  "plain-text": "plain",
  comment: "comment",
  string: "string",
  "template-string": "string",
  "template-punctuation": "string",
  "attr-value": "string",
  regex: "string",
  keyword: "keyword",
  number: "number",
  boolean: "boolean",
  function: "function",
  "function-variable": "function",
  "class-name": "type",
  builtin: "type",
  tag: "tag",
  "attr-name": "attribute",
  operator: "operator",
  punctuation: "punctuation",
};

/** Lines are one-based; columns are zero-based UTF-16 offsets with exclusive ends. */
export function tokenizeSource(
  file: string,
  lines: readonly string[]
): readonly (readonly SyntaxRun[])[] {
  const plain = () =>
    lines.map((line, index): SyntaxRun[] =>
      line.length
        ? [
            {
              line: index + 1,
              startColumn: 0,
              endColumn: line.length,
              kind: "plain",
            },
          ]
        : []
    );
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const language = Object.hasOwn(languages, extension)
    ? languages[extension]
    : undefined;
  if (!language) return plain();
  const source = lines.join("\n");
  const runs: SyntaxRun[][] = lines.map(() => []);
  let offset = 0;
  let lineIndex = 0;
  let column = 0;
  function visit(node: RootContent, inherited: SyntaxKind): void {
    if (node.type === "element") {
      let kind = inherited;
      const classes = node.properties.className;
      if (Array.isArray(classes)) {
        for (const name of classes) {
          if (typeof name === "string" && Object.hasOwn(kinds, name)) {
            kind = kinds[name];
            break;
          }
        }
      }
      for (const child of node.children) visit(child, kind);
    } else if (node.type === "text") {
      // A grammar update must never shift positions or substitute decoded text.
      if (source.slice(offset, offset + node.value.length) !== node.value)
        throw Error("Grammar did not conserve source text.");
      offset += node.value.length;
      const segments = node.value.split("\n");
      for (const [index, segment] of segments.entries()) {
        if (index) {
          lineIndex++;
          column = 0;
        }
        if (segment.length) {
          runs[lineIndex].push({
            line: lineIndex + 1,
            startColumn: column,
            endColumn: column + segment.length,
            kind: inherited,
          });
          column += segment.length;
        }
      }
    }
  }
  try {
    for (const node of refractor.highlight(source, language).children)
      visit(node, "plain");
    return offset === source.length ? runs : plain();
  } catch {
    // Reading and native navigation remain available if a grammar cannot color a file.
    return plain();
  }
}
