import { allChanges } from "./git-project.mjs";

export function side(title, purpose, startLine = 1, endLine = 1) {
  return {
    title,
    purpose,
    startLine,
    endLine,
    notes: [{ body: title + " block behavior", startLine, endLine }],
    variables: [
      {
        name: "amount",
        body: title + " named amount",
        occurrences: [{ line: 1, startColumn: 6 }],
      },
    ],
  };
}
export async function authorFixture(f) {
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  f.git("add", "--", "part.ts");
  f.write(
    "part.ts",
    "const amount = 3;\nconst expanded = amount + 1;\nconsole.log(expanded);\n// additional saved context\n"
  );
  f.write(
    "long.ts",
    "const amount = 4;\n" +
      Array.from(
        { length: 34 },
        (_, i) => `// explicit added context line ${i + 2}`
      ).join("\n") +
      "\n"
  );
  const list = await allChanges(f.service);
  const staged = list.files.find(
    (file) => file.file === "part.ts" && file.group === "staged"
  );
  const unstaged = list.files.find(
    (file) => file.file === "part.ts" && file.group === "unstaged"
  );
  const first = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: staged.id,
  });
  const second = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: unstaged.id,
  });
  const added = list.files.find((file) => file.file === "long.ts");
  const third = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: added.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Amount evolution",
    listId: list.listId,
    steps: [
      {
        id: "initial",
        title: "Choose the amount",
        fileId: staged.id,
        binding: first.binding,
        before: side("Original amount", "Begin with the committed value."),
        after: side("Staged amount", "Use the explicitly staged value."),
      },
      {
        id: "expanded",
        title: "Expand the calculation",
        fileId: unstaged.id,
        binding: second.binding,
        before: side(
          "Staged calculation",
          "Keep the staged constant before expansion."
        ),
        after: side(
          "Expanded saved calculation",
          "Compute a derived value and report it using the saved working source, without claiming the editor buffer is saved.",
          1,
          4
        ),
      },
      {
        id: "introduced",
        title: "Introduce saved context",
        fileId: added.id,
        binding: third.binding,
        before: {
          title: "No earlier file",
          purpose: "This untracked source had no earlier file in the index.",
          startLine: 0,
          endLine: 0,
          notes: [],
          variables: [],
          notApplicable: {
            notes: "There is no earlier source block.",
            variables: "There are no earlier identifiers.",
          },
        },
        after: side(
          "Introduced context",
          "Show the whole intentionally selected new source, without clipping its vertical space.",
          1,
          35
        ),
      },
    ],
  });
  return { saved, list, first, second };
}
