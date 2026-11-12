import { allChanges } from "./git-project.mjs";

export const reviewMarkdown =
  '## Side note\n\n**Exact** `amount` and ~~old~~.\n\n- Keep the source\n- Keep the scope\n\n<img src="https://invalid.example/comparison-image">\n\n[unsafe](javascript:alert(1)) ![alt only](https://invalid.example/comparison-pixel)';
const source = (name, value) =>
  [
    `function ${name}() {`,
    `  const amount = ${value};`,
    "  items.map((item) => {",
    "    return amount + item;",
    "  });",
    "  return amount;",
    "}",
    "function sibling() { return 0; }",
    "",
  ].join("\n");

// Uses only the supplied disposable Git root; no real project/store access.
export async function composeReviewFixture(f) {
  f.write("composed.ts", source("beforeOrder", 1));
  f.git("add", "--", "composed.ts");
  f.git("commit", "--quiet", "-m", "composed fixture before");
  f.write("composed.ts", source("indexOrder", 2));
  f.git("add", "--", "composed.ts");
  f.write("composed.ts", source("liveOrder", 3));
  const ordinary = await f.service.call("save_walkthrough", {
    title: "Ordinary composition",
    steps: [
      {
        id: "live",
        title: "Not a function name",
        source: { file: "composed.ts", startLine: 2, endLine: 5 },
        explanation: "Original ordinary purpose",
      },
    ],
  });
  const list = await allChanges(f.service);
  const file = list.files.find(
    (file) => file.file === "composed.ts" && file.group === "staged"
  );
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const side = (title, startLine, endLine) => ({
    title,
    purpose: "Authored purpose, not lexical context",
    startLine,
    endLine,
    notes: [{ body: reviewMarkdown, startLine, endLine }],
    variables: [
      {
        name: "amount",
        body: reviewMarkdown,
        occurrences: [{ line: 4, startColumn: 11 }],
      },
    ],
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Composed Git review",
    listId: list.listId,
    steps: [
      {
        id: "common",
        title: "Common owner",
        fileId: file.id,
        binding: view.binding,
        before: side("Earlier common", 2, 5),
        after: side("Staged common", 2, 5),
      },
      {
        id: "nested",
        title: "Nested owner",
        fileId: file.id,
        binding: view.binding,
        before: side("Earlier nested", 4, 4),
        after: side("Staged nested", 4, 4),
      },
    ],
  });
  return { saved, ordinary };
}
