// Guarded authoring recipe for the EXISTING review-ticket-28 guide. Import this
// from a parent-owned authenticated client; no connection/token/private JSON is
// read here. prepare is pure observation; publish is an EXPLICIT write operation.
// No source hashes/revisions are baked in, and no name-matched calls are inferred.
const cards = [
  [
    "semantic-flow-view",
    "Show the diagram and open its cards",
    "ui/walkthrough-flow.tsx",
    "WalkthroughFlow",
    "Shows the saved diagram when its linked code still matches. Selecting a box reveals its card and exact code within the card row and code pane, without moving the page or diagram.",
    "Selecting a box checks the latest walkthrough before selecting its card and exact source. Only the card row and selected code pane move; the page, diagram and keyboard focus stay put.",
    "current",
    "const current = latest.current;",
    "The latest walkthrough, checked when a diagram box is clicked. It may be newer than the one used to draw the diagram.",
  ],
  [
    "semantic-flow-render",
    "Draw the diagram and ignore old results",
    "ui/walkthrough-flow.tsx",
    "Diagram",
    "Draws one diagram at a time. Only a result that still belongs to the open view can be displayed and used to select cards.",
    "If this view has closed, skip work that has not started. Check again after Mermaid finishes so an old result cannot replace the current diagram. This does not stop a calculation already in progress.",
    "cancelled",
    "let cancelled = false;",
    "Whether this drawing job's view has closed. When true, skip the job or ignore its finished result.",
  ],
  [
    "semantic-flow-svg",
    "Copy only safe diagram elements",
    "ui/walkthrough-flow.tsx",
    "passiveSvg",
    "Builds a clean copy of the diagram from allowed SVG elements. The application adds card-click actions only after this copy is made.",
    "Copy text as text. For each allowed SVG child, call the same copying function again; leave out HTML, external resources and event handlers from the rendered result.",
    "child",
    "for (const child of Array.from(node.childNodes))",
    "The child being examined in this loop: copy its text, copy its allowed SVG children, or leave it out.",
  ],
  [
    "semantic-flow-project",
    "Check whether the linked code has changed",
    "walkthrough-flow.mts",
    "projectWalkthroughFlow",
    "Checks whether the diagram's saved links still match the code. If a card is missing or its source has changed, marks the diagram out of date; otherwise prepares it for display.",
    "filter collects boxes whose source is missing, unreadable or changed. One failed check blocks the whole diagram; it does not silently move a box to different code. Matching source does not prove the arrows explain the program correctly.",
    "invalid",
    "const invalid = graph.nodes.filter",
    "The boxes that failed the source checks. An empty list means every box still matches its recorded code.",
  ],
  [
    "semantic-flow-parse",
    "Reject an incomplete or oversized diagram",
    "walkthrough-flow.mts",
    "parseWalkthroughFlow",
    "Checks the diagram's format, box names, arrows and size. Rejects an invalid diagram instead of silently dropping parts of it.",
    "Each decision needs one true arrow and one false arrow leading to different boxes. These format checks cannot establish that the arrows describe the program correctly; the author must check the code too.",
    "ids",
    "const ids = new Set<string>();",
    "The box names already seen. This set catches duplicate names and arrows that refer to a missing box.",
  ],
  [
    "semantic-flow-admit",
    "Check the diagram before saving it",
    "walkthrough-flow.mts",
    "admitWalkthroughFlow",
    "Checks the diagram's format and linked code before allowing it to be saved. Returns the checked diagram only if both checks pass.",
    "First parse the supplied diagram. Then check its boxes against the code on their cards. A failure stops the save; passing these checks does not rewrite or approve the cards' explanations.",
    "graph",
    "const graph = parseWalkthroughFlow(value);",
    "The supplied diagram after its format checks. Its links still need to be checked against the cards' code.",
  ],
  [
    "semantic-flow-save",
    "Save or clear the diagram",
    "workspace.mts",
    null,
    "Saves or clears the diagram only if the walkthrough has not changed since it was read. If saving fails, restores the previous workspace state and reports the failure.",
    "null removes only the diagram. Otherwise, check the new diagram against the cards' current code. Save the updated workspace; if that throws, restore the previous state so the rejected change cannot appear in a later save.",
    "original",
    "const original = get(a.walkthroughId);",
    "The saved walkthrough being updated. Its revision is checked before changing its diagram.",
  ],
  [
    "semantic-flow-drafts",
    "Keep each card's unfinished note",
    "ui/notes.tsx",
    "useNoteDraft",
    "Keeps each card's unfinished note separate. A save reply cannot erase text written later or clear a different card's draft.",
    "Remember which card and text version were saved. When the reply arrives, clear only that unchanged draft. Leave newer edits and the note on any other card alone.",
    "submittedScope",
    "const submittedScope = scope.current;",
    "The walkthrough and card that owned this note when Save was pressed, even if another card is open when the reply arrives.",
  ],
];
const blockAnchors = {
  "semantic-flow-view": [
    "const current = latest.current;",
    "selectCard(focus);",
  ],
  "semantic-flow-render": [
    "if (cancelled) return;",
    "const passive = passiveSvg(svg);",
  ],
  "semantic-flow-svg": [
    "for (const child of Array.from(node.childNodes))",
    "return element;",
  ],
  "semantic-flow-project": [
    "const invalid = graph.nodes.filter",
    'no connections have been reattached.",\n    };',
  ],
  "semantic-flow-parse": [
    "for (const n of nodes)",
    "return { version: 1, summary: value.summary, nodes, edges };",
  ],
  "semantic-flow-drafts": [
    "const submittedScope = scope.current;",
    "await refresh();",
  ],
};
const specs = [
  [
    "view",
    "semantic-flow-view",
    "entry",
    "Open Flow",
    "const flow = walkthrough?.flowState;",
  ],
  [
    "available",
    "semantic-flow-view",
    "decision",
    "Can the saved diagram be shown?",
    'flow?.status === "current"',
  ],
  [
    "hidden",
    "semantic-flow-view",
    "exit",
    "Leave the diagram hidden",
    'flow?.message ?? "No walkthrough selected."',
  ],
  [
    "render",
    "semantic-flow-render",
    "call",
    "Wait for this drawing job's turn",
    "rendering = rendering",
  ],
  [
    "cancel",
    "semantic-flow-render",
    "decision",
    "Has this view closed?",
    "if (cancelled) return;",
  ],
  [
    "done",
    "semantic-flow-render",
    "exit",
    "Skip this drawing job",
    "if (cancelled) return;",
  ],
  [
    "mermaid",
    "semantic-flow-render",
    "unresolved",
    "Mermaid draws the diagram",
    "await mermaid.render(renderId, source)",
  ],
  [
    "reply",
    "semantic-flow-render",
    "decision",
    "Has the view closed or its target gone?",
    "if (cancelled || !target.current) return;",
  ],
  [
    "discard",
    "semantic-flow-render",
    "exit",
    "Ignore this drawing result",
    "if (cancelled || !target.current) return;",
  ],
  [
    "sanitize",
    "semantic-flow-render",
    "call",
    "Copy allowed diagram elements",
    "const passive = passiveSvg(svg);",
  ],
  [
    "copy",
    "semantic-flow-svg",
    "call",
    "Copy root SVG",
    "const svg = copy(root);",
  ],
  [
    "children",
    "semantic-flow-svg",
    "decision",
    "More child nodes?",
    "for (const child of Array.from(node.childNodes))",
  ],
  [
    "text",
    "semantic-flow-svg",
    "decision",
    "Text child?",
    "child.nodeType === Node.TEXT_NODE",
  ],
  [
    "appendtext",
    "semantic-flow-svg",
    "process",
    "Copy text only",
    'element.append(document.createTextNode(child.textContent ?? ""));',
  ],
  [
    "allowed",
    "semantic-flow-svg",
    "decision",
    "Permitted SVG child?",
    "tags.has(child.localName)",
  ],
  [
    "recurse",
    "semantic-flow-svg",
    "call",
    "Recursively copy SVG child",
    "element.append(copy(child));",
  ],
  [
    "join",
    "semantic-flow-svg",
    "join",
    "Advance child loop",
    "for (const child of Array.from(node.childNodes))",
  ],
  [
    "returncopy",
    "semantic-flow-svg",
    "exit",
    "Return copied element to caller",
    "return element;",
  ],
  [
    "returnsvg",
    "semantic-flow-svg",
    "exit",
    "Return the clean diagram",
    "return svg;",
  ],
  [
    "renderfail",
    "semantic-flow-render",
    "exit",
    "Report drawing failure; keep the cards",
    '"Flow could not be rendered. The ordered cards remain available."',
  ],
  [
    "publish",
    "semantic-flow-render",
    "exit",
    "Show the diagram with card links",
    "target.current.replaceChildren(passive);",
  ],
  [
    "project",
    "semantic-flow-project",
    "entry",
    "Read the saved diagram",
    "if (!graph)",
  ],
  [
    "hasgraph",
    "semantic-flow-project",
    "decision",
    "Is there a saved diagram?",
    "if (!graph)",
  ],
  [
    "absent",
    "semantic-flow-project",
    "exit",
    "Show no diagram",
    '"Flow has not been authored for this walkthrough."',
  ],
  [
    "bindings",
    "semantic-flow-project",
    "decision",
    "Did any source check fail?",
    "if (invalid.length)",
  ],
  [
    "stale",
    "semantic-flow-project",
    "exit",
    "Mark the diagram out of date",
    'status: "stale"',
  ],
  [
    "generate",
    "semantic-flow-project",
    "process",
    "Prepare the saved boxes and arrows",
    "for (const e of graph.edges)",
  ],
  [
    "save",
    "semantic-flow-save",
    "entry",
    "Receive a diagram update",
    "const original = get(a.walkthroughId);",
  ],
  [
    "clear",
    "semantic-flow-save",
    "decision",
    "Was the diagram set to null?",
    "a.graph === null",
  ],
  [
    "admit",
    "semantic-flow-save",
    "call",
    "Check the new diagram",
    "admitWalkthroughFlow(a.graph, hydrate(original).steps)",
  ],
  [
    "admission",
    "semantic-flow-admit",
    "call",
    "Check the diagram's format",
    "parseWalkthroughFlow(value)",
  ],
  [
    "parse",
    "semantic-flow-parse",
    "process",
    "Check box names, arrows and size",
    "const ids = new Set<string>();",
  ],
  [
    "check",
    "semantic-flow-admit",
    "call",
    "Check the linked code",
    "projectWalkthroughFlow(graph, steps)",
  ],
  [
    "commit",
    "semantic-flow-save",
    "join",
    "Save the updated workspace",
    "save();",
  ],
  [
    "committed",
    "semantic-flow-save",
    "exit",
    "Return the updated walkthrough",
    "return hydrate(updated);",
  ],
  [
    "rollback",
    "semantic-flow-save",
    "exit",
    "Restore the previous state and report failure",
    "state = before;",
  ],
];
const edge = (from, to, kind, label, basis) => ({
  from,
  to,
  kind,
  label,
  basis,
});
const edges = [
  edge(
    "commit",
    "committed",
    "next",
    "if save succeeds",
    "The handler reaches return hydrate(updated) only after synchronous save returns successfully."
  ),
  edge(
    "commit",
    "rollback",
    "next",
    "if save throws",
    "The explicit catch restores state = before and rethrows; this is an error continuation, not an unconditional execution edge."
  ),
  edge(
    "view",
    "available",
    "next",
    "",
    "The Flow view reads the hydrated currentness projection."
  ),
  edge(
    "available",
    "render",
    "true",
    "",
    "The current visible branch mounts Diagram; no reading-order builder is called."
  ),
  edge(
    "available",
    "hidden",
    "false",
    "",
    "Absent, stale or hidden state does not mount Diagram."
  ),
  edge(
    "render",
    "cancel",
    "next",
    "",
    "The promise chain checks disposal before starting Mermaid."
  ),
  edge(
    "cancel",
    "done",
    "true",
    "",
    "Disposed queued work returns without rendering."
  ),
  edge(
    "cancel",
    "mermaid",
    "false",
    "",
    "A live job initializes and awaits real locally bundled Mermaid."
  ),
  edge(
    "mermaid",
    "reply",
    "unresolved",
    "if layout resolves",
    "The library is locally bundled but its internal layout is opaque in this selected guide. Rejection uses the local catch status, not SVG publication."
  ),
  edge(
    "reply",
    "discard",
    "true",
    "",
    "A disposed effect or absent target rejects the awaited result."
  ),
  edge(
    "reply",
    "sanitize",
    "false",
    "",
    "Only a live target receives a passive reconstruction."
  ),
  edge(
    "sanitize",
    "copy",
    "call",
    "",
    "Direct lexical call to passiveSvg in this module, then its nested copy(root)."
  ),
  edge(
    "mermaid",
    "renderfail",
    "unresolved",
    "if layout rejects",
    "The promise catch reports failure; no external renderer output is inserted."
  ),
  edge(
    "sanitize",
    "publish",
    "return",
    "if passiveSvg succeeds",
    "Call-site continuation after reconstruction; not an expanded call stack. Errors leave the local failure status."
  ),
  edge(
    "copy",
    "children",
    "call",
    "",
    "copy(root) enters the lexically nested copy function and its child loop."
  ),
  edge(
    "children",
    "text",
    "true",
    "",
    "Each parsed child is checked for text before SVG recursion."
  ),
  edge(
    "children",
    "returncopy",
    "false",
    "",
    "The lexical copy function returns its constructed element when all children have been examined."
  ),
  edge(
    "copy",
    "returnsvg",
    "return",
    "after root copy returns",
    "Call-site continuation: passiveSvg annotates and returns the copied root SVG. Nested copy frames return to their own callers."
  ),
  edge(
    "text",
    "appendtext",
    "true",
    "",
    "Text nodes are created as text, not interpreted HTML."
  ),
  edge(
    "text",
    "allowed",
    "false",
    "",
    "An element must have the correct namespace and permitted local name."
  ),
  edge("appendtext", "join", "next", "", "Continue examining siblings."),
  edge(
    "allowed",
    "recurse",
    "true",
    "",
    "Only allowed SVG elements enter recursive copying."
  ),
  edge(
    "allowed",
    "join",
    "false",
    "",
    "Unpermitted children are omitted, not inserted as HTML."
  ),
  edge(
    "recurse",
    "children",
    "recursion",
    "",
    "The lexical nested copy(child) recursively applies the same whitelist and child loop."
  ),
  edge(
    "recurse",
    "join",
    "return",
    "after child copy returns",
    "Call-site continuation; recursion stack is not expanded."
  ),
  edge(
    "join",
    "children",
    "loop",
    "",
    "The for-of child loop advances to the next sibling."
  ),
  edge(
    "project",
    "hasgraph",
    "next",
    "",
    "Every read projects without persisting."
  ),
  edge(
    "hasgraph",
    "bindings",
    "true",
    "",
    "Nodes are checked against the actual displayed code hash and exact full-file attachment."
  ),
  edge(
    "hasgraph",
    "absent",
    "false",
    "",
    "No graph means absent, never a card-order fallback."
  ),
  edge(
    "bindings",
    "stale",
    "true",
    "",
    "Any invalid node causes a fail-closed stale result."
  ),
  edge(
    "bindings",
    "generate",
    "false",
    "",
    "Only a fully current graph emits authored nodes and edges."
  ),
  edge(
    "save",
    "clear",
    "next",
    "after revision check",
    "The synchronous handler rejects an outdated walkthrough revision before choosing clear or admission."
  ),
  edge(
    "clear",
    "commit",
    "true",
    "remove flow",
    "Only graph:null clears; existing purposes and notes are retained."
  ),
  edge(
    "clear",
    "admit",
    "false",
    "",
    "Non-null graphs need structural and current-source admission."
  ),
  edge(
    "admit",
    "admission",
    "call",
    "",
    "Imported admitWalkthroughFlow is established by workspace.mts import, not by a bare-name search."
  ),
  edge(
    "admit",
    "commit",
    "return",
    "if admitted",
    "On return, the new graph is placed in copied workspace state and saved synchronously. Errors reject before commit."
  ),
  edge(
    "admission",
    "parse",
    "call",
    "",
    "Direct same-module parseWalkthroughFlow call."
  ),
  edge(
    "admission",
    "check",
    "return",
    "if structure valid",
    "The call-site continues to currentness admission; thrown structural errors stop here."
  ),
  edge(
    "check",
    "project",
    "call",
    "",
    "Direct same-module projectWalkthroughFlow call reuses read projection without writes."
  ),
];
function need(condition, message) {
  if (!condition) throw Error("Semantic Flow publication: " + message);
}
function exact(code, needle) {
  const excerpt = code.lines.slice(code.startLine - 1, code.endLine).join("\n");
  const at = excerpt.indexOf(needle);
  need(
    at >= 0 && excerpt.indexOf(needle, at + 1) < 0,
    "selection is missing or ambiguous: " + needle
  );
  const prefix = excerpt.slice(0, at),
    startLine = code.startLine + prefix.split("\n").length - 1;
  const startColumn = prefix.split("\n").at(-1).length;
  const parts = needle.split("\n");
  return {
    file: code.file,
    fileHash: code.fileHash,
    startLine,
    startColumn,
    endLine: startLine + parts.length - 1,
    endColumn:
      parts.length === 1 ? startColumn + needle.length : parts.at(-1).length,
    text: needle,
  };
}
async function sourcePreview(client, file, symbol) {
  const info = await client.call("inspect_source", { file });
  const read = await client.call("read_source", { file });
  need(info.hash === read.fileHash, "source changed while previewing " + file);
  const lines = read.text.split("\n").map((line) => line.replace(/^\d+: /, ""));
  let startLine, endLine;
  if (symbol) {
    const matches = info.symbols.filter((s) => s.name === symbol);
    need(matches.length === 1, "symbol must be unique: " + symbol);
    ({ startLine, endLine } = matches[0]);
  } else {
    const start = lines.findIndex((line) =>
      line.includes('if (name === "save_walkthrough_flow")')
    );
    const end = lines.findIndex(
      (line, i) =>
        i > start && line.includes('if (name === "delete_walkthrough")')
    );
    need(start >= 0 && end > start, "Flow write block not found");
    startLine = start + 1;
    endLine = end;
  }
  return { file, fileHash: read.fileHash, lines, startLine, endLine };
}
export async function prepareSemanticFlowPublication(
  client,
  id = "review-ticket-28"
) {
  const current = await client.call("get_walkthrough", { id });
  const additions = [];
  for (const [
    stepId,
    title,
    file,
    symbol,
    explanation,
    body,
    variableName,
    variableAnchor,
    variableBody,
  ] of cards) {
    need(
      !current.steps.some((s) => s.id === stepId),
      "addition ID already exists; do not duplicate/review blindly: " + stepId
    );
    const code = await sourcePreview(client, file, symbol);
    // Preflight ALL selectors and all three homes before saving any card.
    const binding = exact(code, variableAnchor);
    const variableColumn =
      binding.startColumn + variableAnchor.indexOf(variableName);
    need(variableAnchor.includes(variableName), "variable anchor missing");
    const variable = {
      ...binding,
      text: variableName,
      endLine: binding.startLine,
      startColumn: variableColumn,
      endColumn: variableColumn + variableName.length,
    };
    const excerpt = code.lines
      .slice(code.startLine - 1, code.endLine)
      .join("\n");
    const anchors = blockAnchors[stepId];
    const blockStart = anchors ? excerpt.indexOf(anchors[0]) : 0;
    const endAt = anchors
      ? excerpt.indexOf(anchors[1], blockStart)
      : excerpt.length;
    const blockEnd = anchors ? endAt + anchors[1].length : excerpt.length;
    need(
      blockStart >= 0 && endAt >= blockStart && blockEnd > blockStart,
      "block selection not found: " + stepId
    );
    const block = exact(code, excerpt.slice(blockStart, blockEnd));
    additions.push({
      step: {
        id: stepId,
        title,
        source: symbol
          ? { file, symbol }
          : { file, startLine: code.startLine, endLine: code.endLine },
        explanation,
        evidence: "source",
      },
      fileHash: code.fileHash,
      body,
      variableName,
      variableBody,
      variable,
      block,
      code,
    });
  }
  for (const [, , , , needle] of specs) {
    need(needle.length > 0, "empty graph selector");
  }
  for (const [, stepId, , , needle] of specs)
    exact(additions.find((a) => a.step.id === stepId).code, needle);
  return {
    id,
    expectedRevision: current.revision,
    additions,
    specs,
    edges,
    summary:
      "Shows how Codepath checks a saved diagram, saves or clears an update, draws it, and copies only allowed SVG elements. Reading and saving are separate entry points. Mermaid's internal drawing steps are not shown. Return arrows mean the caller continues only if the call succeeds; this is a code explanation, not a recording of execution.",
  };
}
export async function publishSemanticFlow(client, plan) {
  // Parent MUST manually review this plan and its source-evidence table first.
  let current = await client.call("get_walkthrough", { id: plan.id });
  need(
    current.revision === plan.expectedRevision,
    "walkthrough changed since plan review"
  );
  for (const a of plan.additions) {
    const info = await client.call("inspect_source", {
      file: a.step.source.file,
    });
    need(info.hash === a.fileHash, "source changed since plan review");
  }
  current = await client.call("save_walkthrough", {
    ...current,
    expectedRevision: current.revision,
    steps: [...current.steps, ...plan.additions.map((a) => a.step)],
  });
  const reviewedCodes = new Map();
  for (const a of plan.additions) {
    const code = current.steps.find((step) => step.id === a.step.id)?.code;
    need(
      code?.fileHash === a.fileHash &&
        code.file === a.code.file &&
        code.startLine === a.code.startLine &&
        code.endLine === a.code.endLine,
      "source changed during authoring; incomplete, not ready"
    );
    reviewedCodes.set(a.step.id, code);
  }
  for (const a of plan.additions) {
    for (const variable of [false, true]) {
      current = await client.call("get_walkthrough", { id: plan.id });
      const code = current.steps.find((s) => s.id === a.step.id).code;
      need(
        code?.fileHash === a.fileHash,
        "source changed during authoring; incomplete, not ready"
      );
      await client.call("add_reviewed_note", {
        walkthroughId: plan.id,
        stepId: a.step.id,
        expectedRevision: current.revision,
        sourceHash: code.hash,
        fileHash: code.fileHash,
        body: variable ? a.variableBody : a.body,
        author: "Codepath semantic Flow author",
        attachments: [variable ? a.variable : a.block],
        ...(variable ? { variableName: a.variableName } : {}),
      });
    }
  }
  current = await client.call("get_walkthrough", { id: plan.id });
  for (const a of plan.additions) {
    const code = current.steps.find((step) => step.id === a.step.id)?.code;
    const reviewed = reviewedCodes.get(a.step.id);
    need(
      code?.fileHash === a.fileHash &&
        code.hash === reviewed.hash &&
        code.file === reviewed.file &&
        code.startLine === reviewed.startLine &&
        code.endLine === reviewed.endLine,
      "source changed during authoring; incomplete, not ready"
    );
  }
  const nodes = plan.specs.map(([id, stepId, kind, label, needle]) => {
    // Bind only the source reviewed before authoring, never fresh hashes from
    // an unrelated edit observed by the final read. Later changes fail admission.
    const code = reviewedCodes.get(stepId);
    need(code, "new card source missing");
    return {
      id,
      stepId,
      kind,
      label,
      sourceHash: code.hash,
      attachment: exact(code, needle),
    };
  });
  const graph = { version: 1, summary: plan.summary, nodes, edges: plan.edges };
  current = await client.call("save_walkthrough_flow", {
    walkthroughId: plan.id,
    expectedRevision: current.revision,
    graph,
  });
  need(
    current.flowState.status === "current",
    "Flow is not current after save"
  );
  const readiness = await client.call("validate_walkthrough", {
    walkthroughId: plan.id,
    expectedRevision: current.revision,
  });
  return { walkthrough: current, readiness }; // Old stale content remains honestly unreviewed.
}
