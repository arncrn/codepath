import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callTool } from "../dist/client.mjs";

// Run from the folder opened in VS Code, or pass that folder as one argument.
// Only the connected Codepath tools write data; never edit workspace.json.
try {
  if (process.argv.length > 3)
    throw Error(
      "Usage: node scripts/create-overview-example.mjs [project-folder]"
    );
  const root = fs.realpathSync(process.argv[2] ?? process.cwd());
  const source = fileURLToPath(
    new URL("../examples/function-context/main.go", import.meta.url)
  );
  const file = path.relative(root, source).split(path.sep).join("/");
  if (file.startsWith("../") || path.isAbsolute(file))
    throw Error(
      "Open this checkout (or its parent) in VS Code and pass that opened folder as the project root."
    );
  const call = (name, args) => callTool(root, name, args);
  const project = await call("project_overview", {});
  if (
    project.root !== root ||
    project.capabilities?.walkthroughOverview !== true
  )
    throw Error(
      "Install the updated VSIX, reload VS Code, then run Codepath: Open Walkthroughs for this folder."
    );
  const id = "go-function-context-cheat-sheet";
  const title = "Go function context · cheat sheet";
  if (project.paths.some((walk) => walk.id === id)) {
    console.log(
      `Open “${title}” in Codepath. The existing example was preserved, not overwritten.`
    );
  } else {
    await call("read_source", { file });
    const specs = [
      {
        id: "callback",
        title: "Inside the callback",
        line: 7,
        purpose: "Prints the callback's message when this function is invoked.",
        note: "This statement is in the local function body. Creating the function value does not execute this print.",
        noVariables:
          "The selected statement only prints a literal string; it references no parameter or local variable.",
      },
      {
        id: "invoke",
        title: "Invoke the callback",
        line: 9,
        purpose: "Runs the previously created callback synchronously.",
        note: "The call site belongs to Server.Handle. Execution enters the callback and returns here before Handle finishes.",
        variable: "callback",
        variableBody:
          "The local function value created earlier in Handle and invoked by this call.",
      },
      {
        id: "private",
        title: "Call the private method",
        line: 13,
        purpose: "Prints the private method's message.",
        note: "The lowercase method name restricts package visibility, not lexical ownership: this statement still belongs to Server.health.",
        noVariables:
          "The selected statement only prints a literal string; the receiver is not referenced here.",
      },
      {
        id: "generic",
        title: "Return the generic value",
        line: 17,
        purpose: "Preserves the supplied value and its type.",
        note: "The return forwards the parameter without validation, conversion or mutation. The type parameter does not make the function name unknown.",
        variable: "value",
        variableBody:
          "The argument received by Identity, returned unchanged to its caller.",
      },
    ];
    let walk = await call("save_walkthrough", {
      id,
      title,
      description:
        "A small Go example for verifying method, callback and generic function context.",
      overview: fs.readFileSync(
        new URL("../examples/function-context/overview.md", import.meta.url),
        "utf8"
      ),
      steps: specs.map((spec) => ({
        id: spec.id,
        title: spec.title,
        explanation: spec.purpose,
        source: { file, startLine: spec.line, endLine: spec.line },
      })),
    });
    const notApplicable = [];
    for (const spec of specs) {
      const code = walk.steps.find((step) => step.id === spec.id).code;
      const line = code.lines[spec.line - 1];
      const attachment = (startColumn, endColumn) => ({
        file,
        fileHash: code.fileHash,
        startLine: spec.line,
        endLine: spec.line,
        startColumn,
        endColumn,
        text: line.slice(startColumn, endColumn),
      });
      const add = async (fields) => {
        await call("add_reviewed_note", {
          walkthroughId: id,
          stepId: spec.id,
          expectedRevision: walk.revision,
          sourceHash: code.hash,
          fileHash: code.fileHash,
          author: "Codepath example",
          ...fields,
        });
        walk = await call("get_walkthrough", { id });
      };
      await add({ body: spec.note, attachments: [attachment(0, line.length)] });
      if (spec.variable) {
        const start = line.indexOf(spec.variable);
        if (start < 0)
          throw Error(
            "Example source changed. Read and repair the example before continuing."
          );
        await add({
          body: spec.variableBody,
          variableName: spec.variable,
          attachments: [attachment(start, start + spec.variable.length)],
        });
      } else
        notApplicable.push({
          stepId: spec.id,
          sourceHash: code.hash,
          fileHash: code.fileHash,
          variables: spec.noVariables,
        });
    }
    walk = await call("get_walkthrough", { id });
    const report = await call("validate_walkthrough", {
      walkthroughId: id,
      expectedRevision: walk.revision,
      notApplicable,
    });
    if (!report.ready)
      throw Error("Example is incomplete: " + JSON.stringify(report.issues));
    console.log(
      `Open “${title}” in Codepath → Overview. Four cards, attached Notes and applicable Variables are ready. The two constant-print cards explicitly have no relevant variables.`
    );
  }
} catch (error) {
  console.error(error.message);
  console.error(
    "If a save failed, the example may be incomplete. Existing walkthroughs and notes were not replaced."
  );
  process.exitCode = 1;
}
