import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startProjectService } from "../dist/service.mjs";
import { tools } from "../dist/tools.mjs";
import { walkthroughAuthoringInstructions } from "../dist/authoring-policy.mjs";

const skill = fs.readFileSync(
  new URL("../skills/codepath/SKILL.md", import.meta.url),
  "utf8"
);
const prompt = fs.readFileSync(
  new URL("../prompts/codepath.md", import.meta.url),
  "utf8"
);
const commands = [...skill.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(
  (match) => match[1]
);

async function run(command, root, agent) {
  const child = spawn("bash", ["-c", command], {
    cwd: root,
    env: { ...process.env, PROJECT_ROOT: root, CODEPATH_AGENT: agent },
    timeout: 10000,
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  child.stdin.end();
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null, stderr);
  return { code, stdout, stderr };
}

test("Portable Codepath skill has discoverable metadata, current tools, and a request-forwarding Pi shortcut", () => {
  assert.match(
    skill,
    /^---\nname: codepath\ndescription: .+\ncompatibility: .+\n---\n/
  );
  assert.match(prompt, /^---\ndescription: .+\nargument-hint: .+\n---\n/);
  assert.match(prompt, /installed `codepath` skill's SKILL\.md/);
  assert.match(prompt, /\$\{@:-/);
  assert.doesNotMatch(skill + prompt, /\/Users\/josh\//);
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "project_overview",
    "get_walkthrough",
    "save_walkthrough",
    "save_walkthrough_overview",
    "add_reviewed_note",
    "review_note",
    "validate_walkthrough",
    "save_walkthrough_flow",
    "create_comparison_walkthrough",
  ]) {
    assert.ok(skill.includes("`" + name + "`"), name + " must be explained");
    assert.ok(names.has(name), name + " must be a real tool");
  }
  assert.equal(commands.length, 3);
});

test("The skill's exact shell examples discover current policy/schemas and call a real project through a standalone bundled agent", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cp-skill-"));
  let service;
  t.after(async () => {
    await service?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const root = path.join(fs.realpathSync(scratch), "project with spaces");
  const agent = path.join(scratch, "agent with spaces", "agent.mjs");
  fs.mkdirSync(root);
  fs.mkdirSync(path.dirname(agent));
  fs.copyFileSync(new URL("../dist/agent.mjs", import.meta.url), agent);
  fs.writeFileSync(
    path.join(root, "main.go"),
    "package main\nfunc Run() {\n  println(1)\n}\n"
  );
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  const walk = await service.call("save_walkthrough", {
    title: "Skill verification",
    steps: [
      {
        id: "run",
        title: "Print the value",
        explanation: "Prints the configured value.",
        source: { file: "main.go", startLine: 3, endLine: 3 },
      },
    ],
  });
  const disk = path.join(root, ".codepaths/workspace.json");
  const before = fs.readFileSync(disk, "utf8");
  const overview = await run(commands[0], root, agent);
  assert.equal(overview.code, 0, overview.stderr);
  assert.equal(JSON.parse(overview.stdout).root, root);

  const discovery = await run(commands[1], root, agent);
  assert.equal(discovery.code, 0, discovery.stderr);
  const replies = discovery.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    replies[0].result.instructions,
    walkthroughAuthoringInstructions
  );
  assert.deepEqual(replies[1].result.tools, JSON.parse(JSON.stringify(tools)));

  const call = (name, args) =>
    run(
      commands[2]
        .replace("TOOL_NAME", name)
        .replace(
          '{"actual":"arguments from the current schema"}',
          JSON.stringify(args)
        ),
      root,
      agent
    );
  const readback = await call("get_walkthrough", { id: walk.id });
  assert.equal(readback.code, 0, readback.stderr);
  const current = JSON.parse(readback.stdout);
  assert.equal(current.steps[0].code.functionContext.name, "Run");
  const validation = await call("validate_walkthrough", {
    walkthroughId: walk.id,
    expectedRevision: current.revision,
  });
  assert.equal(
    validation.code,
    1,
    "Incomplete guides must not look successful to CLI-only agents"
  );
  assert.equal(JSON.parse(validation.stdout).ready, false);
  assert.equal(
    fs.readFileSync(disk, "utf8"),
    before,
    "Skill discovery/readback/validation must not rewrite walkthrough data"
  );
});
