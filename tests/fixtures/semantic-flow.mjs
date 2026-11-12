// Manually worked source/graph, NOT an inferred call graph. The import establishes
// helper identity. `notify` is a parameter: its dynamic target stays unresolved.
export const mainSource = `import { helper } from './helper.mjs';
export function run(items, notify) {
  let total = 0;
  for (const item of items) {
    if (item > 0) {
      total += helper(item);
    } else {
      total -= item;
    }
  }
  notify(total);
  return total;
}
`;
export const helperSource = `export function helper(n) {
  if (n <= 1) return 1;
  return n * helper(n - 1);
}
`;
export const fixtureSteps = [
  {
    id: "run",
    title: "Run",
    source: { file: "main.mjs", symbol: "run" },
    explanation:
      "Accumulate adjusted items, notify an unknown callback and return the total.",
  },
  {
    id: "helper",
    title: "Recursive helper",
    source: { file: "helper.mjs", symbol: "helper" },
    explanation: "Multiply positive integers down to the base case.",
  },
];
export function fixtureGraph(walk) {
  const node = (id, kind, label, stepId, line, text) => {
    const code = walk.steps.find((s) => s.id === stepId).code;
    const startColumn = code.lines[line - 1].indexOf(text);
    if (startColumn < 0)
      throw Error("Fixture source selection missing: " + text);
    return {
      id,
      kind,
      label,
      stepId,
      sourceHash: code.hash,
      attachment: {
        file: code.file,
        fileHash: code.fileHash,
        startLine: line,
        endLine: line,
        startColumn,
        endColumn: startColumn + text.length,
        text,
      },
    };
  };
  const edge = (from, to, kind, basis) => ({
    from,
    to,
    kind,
    label: "",
    basis,
  });
  return {
    version: 1,
    summary:
      "Selected run and helper flow; call edges enter bodies, return edges show call-site continuations (not stack tracing). notify target is dynamic. Exceptions omitted; not runtime execution.",
    nodes: [
      node("entry", "entry", "Run begins", "run", 3, "let total = 0;"),
      node(
        "loop",
        "decision",
        "Another item?",
        "run",
        4,
        "for (const item of items)"
      ),
      node("positive", "decision", "item > 0?", "run", 5, "item > 0"),
      node("invoke", "call", "helper(item)", "run", 6, "helper(item)"),
      node(
        "subtract",
        "process",
        "Subtract nonpositive item",
        "run",
        8,
        "total -= item;"
      ),
      node("join", "join", "Next iteration", "run", 9, "}"),
      node(
        "notify",
        "unresolved",
        "Dynamic notify: target unknown",
        "run",
        11,
        "notify(total)"
      ),
      node("exit", "exit", "Return total", "run", 12, "return total;"),
      node("base", "decision", "n <= 1?", "helper", 2, "n <= 1"),
      node("one", "exit", "Return 1", "helper", 2, "return 1;"),
      node("recur", "call", "helper(n - 1)", "helper", 3, "helper(n - 1)"),
      node(
        "multiply",
        "exit",
        "Return multiplied recursive result",
        "helper",
        3,
        "return n * helper(n - 1);"
      ),
    ],
    edges: [
      edge("entry", "loop", "next", "Initialize total before iterating."),
      edge(
        "loop",
        "positive",
        "true",
        "A for-of iteration binds item before the condition."
      ),
      edge(
        "loop",
        "notify",
        "false",
        "After iteration exhaustion, execution reaches notify."
      ),
      edge(
        "positive",
        "invoke",
        "true",
        "Positive branch directly invokes imported helper."
      ),
      edge(
        "positive",
        "subtract",
        "false",
        "Else subtracts the nonpositive item."
      ),
      edge(
        "invoke",
        "base",
        "call",
        "Named import from ./helper.mjs establishes this helper binding."
      ),
      {
        ...edge(
          "invoke",
          "join",
          "return",
          "If helper returns, run adds its result to total and continues this iteration."
        ),
        label: "if helper returns; add to total",
      },
      edge(
        "subtract",
        "join",
        "next",
        "Else completes and rejoins the iteration."
      ),
      edge("join", "loop", "loop", "For-of advances to its next item."),
      edge(
        "notify",
        "exit",
        "unresolved",
        "Callback target and possible exceptions unknown; if it returns, return total follows."
      ),
      edge("base", "one", "true", "Base case returns 1."),
      edge(
        "base",
        "recur",
        "false",
        "Nonbase case evaluates recursive helper."
      ),
      edge(
        "recur",
        "base",
        "recursion",
        "Lexical self-reference to helper in this same function."
      ),
      {
        ...edge(
          "recur",
          "multiply",
          "return",
          "If the recursive call returns, multiply its result by n; caller stack is not expanded."
        ),
        label: "if recursive call returns",
      },
    ],
  };
}
