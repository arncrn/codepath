import type { FunctionScopes } from "./types.mjs";

// Scope extraction only, not a Go compiler or the approximate navigation index.
// Strings/comments have already been masked, preserving offsets and newlines.
// Balanced signature types distinguish a body from struct/interface braces and
// function types. No Go installation or project build is needed by the reader.
export function goFunctionScopes(text: string, clean: string): FunctionScopes {
  const tokens = [...clean.matchAll(/[\p{L}_][\p{L}\p{Nd}_]*|<-|[^\s]/gu)].map(
    (match) => ({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  );
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const unknown: FunctionScopes = { functions: [], reliable: false };
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (["(", "[", "{"].includes(value)) stack.push(i);
    else if (Object.hasOwn(closing, value)) {
      const open = stack.pop();
      if (open === undefined || tokens[open].value !== closing[value])
        return unknown;
      pairs.set(open, i);
      pairs.set(i, open);
    }
  }
  if (stack.length) return unknown;
  const value = (i: number) => tokens[i]?.value;
  const keywords = new Set(
    "break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var".split(
      " "
    )
  );
  const identifier = (i: number) =>
    /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(value(i) ?? "") &&
    !keywords.has(value(i)!);
  const afterGroup = (i: number) => {
    const end = pairs.get(i);
    return end === undefined ? undefined : end + 1;
  };
  const newlineBefore = (i: number) =>
    i > 0 &&
    !!tokens[i] &&
    clean.slice(tokens[i - 1].end, tokens[i].start).includes("\n");

  function signature(parameters: number, depth = 0): number | undefined {
    if (value(parameters) !== "(" || depth > 64) return undefined;
    const next = afterGroup(parameters);
    if (next === undefined) return undefined;
    // A newline after ')' inserts a semicolon: a function type on one line
    // must not consume the next declaration as its result type.
    if (newlineBefore(next)) return next;
    if (value(next) === "(") return afterGroup(next); // named/multiple results
    if (
      ["{", "}", ")", "]", ",", ";", "=", ":", "|", undefined].includes(
        value(next)
      )
    )
      return next;
    return typeEnd(next, depth + 1);
  }
  function typeEnd(start: number, depth: number): number | undefined {
    if (depth > 64) return undefined;
    let i = start;
    while (i < tokens.length) {
      switch (value(i)) {
        case "*":
          i++;
          continue;
        case "[": {
          const next = afterGroup(i);
          if (next === undefined) return undefined;
          i = next;
          continue;
        }
        case "map": {
          if (value(i + 1) !== "[") return undefined;
          const next = afterGroup(i + 1);
          if (next === undefined) return undefined;
          i = next;
          continue;
        }
        case "<-":
          if (value(i + 1) !== "chan") return undefined;
          i += 2;
          continue;
        case "chan":
          i += value(i + 1) === "<-" ? 2 : 1;
          continue;
        case "func":
          return signature(i + 1, depth + 1);
        case "struct":
        case "interface":
          return value(i + 1) === "{" ? afterGroup(i + 1) : undefined;
        case "(":
          return afterGroup(i);
        default: {
          if (!identifier(i)) return undefined;
          i++;
          if (value(i) === ".") {
            if (!identifier(i + 1)) return undefined;
            i += 2;
          }
          return value(i) === "[" ? afterGroup(i) : i;
        }
      }
    }
    return undefined;
  }

  function collectionTypeBefore(index: number) {
    let prefix = index - 1;
    while (prefix >= 0) {
      if (value(prefix) === "*") prefix--;
      else if (value(prefix) === "chan") {
        prefix--;
        if (value(prefix) === "<-") prefix--;
      } else if (value(prefix) === "<-" && value(prefix - 1) === "chan")
        prefix -= 2;
      else break;
    }
    if (value(prefix) !== "]" || newlineBefore(prefix + 1)) return false;
    if (prefix === index - 1) return true;
    // After intervening pointers/channels, distinguish a collection type from
    // indexing followed by an operator: values[0] * func() int { ... }().
    while (value(prefix) === "]") {
      const open = pairs.get(prefix)!;
      if (open + 1 === prefix || value(open - 1) === "map") return true;
      prefix = open - 1;
    }
    return !identifier(prefix) && ![")", "}"].includes(value(prefix) ?? "");
  }

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") lineStarts.push(i + 1);
  function position(offset: number) {
    let low = 0,
      high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { startLine: low + 1, startColumn: offset - lineStarts[low] };
  }
  const functions: FunctionScopes["functions"] = [];
  const parents: FunctionScopes["functions"] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (value(i) !== "func") continue;
    const start = tokens[i].start;
    const typePrefix = collectionTypeBefore(i);
    let parameters = i + 1,
      name = "anonymous";
    if (identifier(parameters)) {
      name = value(parameters)!;
      parameters++;
      if (value(parameters) === "[")
        parameters = afterGroup(parameters) ?? tokens.length;
    } else if (value(parameters) === "(") {
      const next = afterGroup(parameters);
      if (
        next !== undefined &&
        !newlineBefore(next) &&
        identifier(next) &&
        value(next + 1) === "("
      ) {
        // Receiver methods, including unnamed, pointer and generic receivers.
        const close = next - 1;
        let receiver = parameters + 1;
        if (typeEnd(receiver, 0) !== close) receiver++;
        if (typeEnd(receiver, 0) !== close) return unknown;
        if (value(receiver) === "*") receiver++;
        name = value(receiver) + "." + value(next);
        parameters = next + 1;
      }
    }
    const body = signature(parameters);
    if (body === undefined) return unknown;
    // Do not visit func tokens inside this signature: a returned function type
    // ends immediately before the OUTER body, but does not own that body.
    i = body - 1;
    // A function element type in []func(){...} or map[K]func(){...}
    // is followed by a composite literal, not by its own function body.
    if (value(body) !== "{" || newlineBefore(body) || typePrefix) continue; // type or bodyless declaration
    const end = pairs.get(body);
    if (end === undefined) return unknown;
    while (parents.length && parents[parents.length - 1].end <= start)
      parents.pop();
    const parent = parents[parents.length - 1];
    const fn = {
      name: parent ? parent.name + " › " + name : name,
      start,
      end: tokens[end].end,
      ...position(start),
    };
    functions.push(fn);
    parents.push(fn);
  }
  return { functions, reliable: true };
}
