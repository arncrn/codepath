import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFiles, PackageManager } from "@vscode/vsce";

test("VSIX allowlist includes runtime assets, never demo caches or source metadata", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(
    new URL("../.vscodeignore", import.meta.url),
    path.join(root, ".vscodeignore")
  );
  fs.copyFileSync(
    new URL("../package.json", import.meta.url),
    path.join(root, "package.json")
  );
  const release = [
    "extension.cjs",
    "ui.html",
    "ui.js",
    "style.css",
    "vscode.css",
    "agent.mjs",
    "client.mjs",
    "tools.mjs",
    "types.mjs",
  ];
  const unwanted = [
    "dist/.cache/checkout-go",
    "dist/.cache/demo.js",
    "dist/.cache/ui.js",
    ".codepaths/workspace.json",
    "ui.tsx",
    "workspace.mts",
    "skills/codepath/private.json",
    "prompts/unrelated.md",
  ];
  for (const file of [
    ...release.map((file) => "dist/" + file),
    ...unwanted,
    "skills/codepath/SKILL.md",
    "prompts/codepath.md",
    "README.md",
    "LICENSE",
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fixture\n");
  }
  // Exercise VSCE's real pattern handling: a later ignore cannot override an
  // earlier !dist/** allowlist, unlike ordered .gitignore semantics.
  const files = await listFiles({
    cwd: root,
    packageManager: PackageManager.None,
  });
  for (const file of release) assert.ok(files.includes("dist/" + file), file);
  assert.ok(files.includes("skills/codepath/SKILL.md"));
  assert.ok(files.includes("prompts/codepath.md"));
  for (const file of unwanted)
    assert.ok(!files.includes(file), file + " must not ship");
});
