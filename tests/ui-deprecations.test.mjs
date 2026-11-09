import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";

test("Browser source does not use deprecated types or signatures", () => {
  const projectRoot = process.cwd();
  const configuration = ts.readConfigFile("tsconfig.ui.json", ts.sys.readFile);
  assert.equal(configuration.error, undefined);
  const parsedConfiguration = ts.parseJsonConfigFileContent(
    configuration.config,
    ts.sys,
    projectRoot
  );
  assert.deepEqual(parsedConfiguration.errors, []);
  const program = ts.createProgram(
    parsedConfiguration.fileNames,
    parsedConfiguration.options
  );
  const browserDirectory = path.join(projectRoot, "ui") + path.sep;
  const browserEntry = path.join(projectRoot, "ui.tsx");
  const deprecatedUsages = program
    .getSourceFiles()
    .filter(
      (source) =>
        !source.isDeclarationFile &&
        (source.fileName === browserEntry ||
          source.fileName.startsWith(browserDirectory))
    )
    .flatMap((source) => program.getSuggestionDiagnostics(source))
    .filter((diagnostic) => [6385, 6387].includes(diagnostic.code))
    .map((diagnostic) => {
      const position = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start
      );
      return `${path.relative(projectRoot, diagnostic.file.fileName)}:${position.line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    });
  // Deprecations are editor suggestions, so tsc's normal error check misses them.
  assert.deepEqual(deprecatedUsages, []);
});
