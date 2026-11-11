import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startProjectService } from "../dist/service.mjs";
import { callTool } from "../dist/client.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture(
  t,
  {
    source = "export function total(price: number, quantity: number) {\n  const amount = price * quantity;\n  return amount;\n}\n",
    explanation = "Multiplies the price by the quantity and returns the line total.",
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-authoring-"));
  fs.writeFileSync(path.join(root, "total.ts"), source);
  const service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const walk = await service.call("save_walkthrough", {
    title: "Total",
    steps: [
      {
        id: "total",
        title: "Total",
        source: { file: "total.ts", symbol: "total" },
        explanation,
      },
    ],
  });
  return {
    root,
    service,
    walk,
    check: (current = walk, extra = {}) =>
      callTool(root, "validate_walkthrough", {
        walkthroughId: current.id,
        expectedRevision: current.revision,
        ...extra,
      }),
  };
}

async function reviewed(service, walk, fields) {
  const current = await service.call("get_walkthrough", { id: walk.id });
  const code = current.steps[0].code;
  return service.call("add_reviewed_note", {
    walkthroughId: current.id,
    stepId: "total",
    expectedRevision: current.revision,
    sourceHash: code.hash,
    fileHash: code.fileHash,
    author: "Authoring test",
    ...fields,
  });
}
async function annotate(service, walk) {
  const code = walk.steps[0].code;
  const block = {
    file: code.file,
    fileHash: code.fileHash,
    startLine: 2,
    startColumn: 0,
    endLine: 3,
    endColumn: code.lines[2].length,
    text: code.lines.slice(1, 3).join("\n"),
  };
  await reviewed(service, walk, {
    body: "Compute the line amount before returning it to the caller.",
    attachments: [block],
  });
  await reviewed(service, walk, {
    body: "The computed line total that this call returns.",
    variableName: "amount",
    attachments: [2, 3].map((line) => {
      const start = code.lines[line - 1].indexOf("amount");
      return {
        file: code.file,
        fileHash: code.fileHash,
        startLine: line,
        startColumn: start,
        endLine: line,
        endColumn: start + 6,
        text: "amount",
      };
    }),
  });
  return service.call("get_walkthrough", { id: walk.id });
}

async function agentRun(root, input, args = []) {
  const isolated = fs.mkdtempSync(
    path.join(os.tmpdir(), "cp-agent-standalone-")
  );
  try {
    const script = path.join(isolated, "agent.mjs");
    fs.copyFileSync(new URL("../dist/agent.mjs", import.meta.url), script);
    const child = spawn(process.execPath, [script, "--root", root, ...args], {
      cwd: isolated,
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
    child.stdin.end(input);
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

test("Cards alone are saveable but cannot pass the generated walkthrough check, and checking never writes", async (t) => {
  const { root, walk, check } = await fixture(t);
  const file = path.join(root, ".codepaths/workspace.json"),
    before = fs.readFileSync(file, "utf8");
  const result = await check();
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    "missing-block-notes",
    "missing-variables",
  ]);
  assert.equal(result.revision, walk.revision);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("A complete highlighted guide passes, but changed source cannot reuse that readiness", async (t) => {
  const { root, service, walk, check } = await fixture(t);
  const current = await annotate(service, walk);
  let result = await check(current);
  assert.equal(result.ready, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.steps[0].blockNotes, 1);
  assert.deepEqual(
    result.steps[0].variables.map((entry) => [entry.name, entry.occurrences]),
    [["amount", 2]]
  );
  fs.writeFileSync(
    path.join(root, "total.ts"),
    "export function total(price: number, quantity: number) {\n  const amount = price + quantity;\n  return amount;\n}\n"
  );
  result = await check(current);
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((issue) => issue.code === "stale-card"));
  assert.ok(result.issues.some((issue) => issue.code === "stale-note"));
});

test("Genuinely inapplicable categories need explicit reasons tied to the reviewed source, never silent omission", async (t) => {
  const { walk, check } = await fixture(t, {
    source: "export function total() { return 1; }\n",
    explanation: "Returns the configured constant.",
  });
  const code = walk.steps[0].code;
  const waiver = {
    stepId: "total",
    sourceHash: code.hash,
    fileHash: code.fileHash,
    notes:
      "The single constant return has no separate block behavior beyond the card purpose.",
    variables: "There are no parameters or local variables in this function.",
  };
  const result = await check(walk, { notApplicable: [waiver] });
  assert.equal(result.ready, true);
  assert.deepEqual(result.notApplicable, [waiver]);
  await assert.rejects(
    check(walk, { notApplicable: [{ ...waiver, notes: " " }] }),
    /reason/i
  );
  await assert.rejects(
    check(walk, { notApplicable: [{ ...waiver, fileHash: "old" }] }),
    /Source changed/
  );
  await assert.rejects(
    check(walk, { notApplicable: [{ ...waiver, stepId: "missing" }] }),
    /Unknown card/
  );
  await assert.rejects(
    check(walk, { notApplicable: [waiver, waiver] }),
    /duplicate/
  );
});

test("Legacy prose notes stay saveable but neither classification nor highlighting is guessed", async (t) => {
  const { root, service, walk, check } = await fixture(t);
  const ids = [];
  for (const body of [
    "Multiply the inputs, then return the result.",
    "amount: The computed line total.",
  ])
    ids.push(
      (
        await service.call("add_note", {
          walkthroughId: walk.id,
          stepId: "total",
          body,
          author: "Plain note",
        })
      ).id
    );
  const current = await service.call("get_walkthrough", { id: walk.id });
  const before = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  const result = await check(current);
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.code === "unbound-note")
      .map((issue) => issue.noteId),
    ids
  );
  assert.deepEqual(result.steps[0].variables, []);
  assert.equal(result.steps[0].blockNotes, 0);
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    before
  );
  const code = current.steps[0].code;
  const waived = await check(current, {
    notApplicable: [
      {
        stepId: "total",
        sourceHash: code.hash,
        fileHash: code.fileHash,
        notes: "Deliberate plain notes",
        variables: "No additional variable entry",
      },
    ],
  });
  assert.equal(
    waived.ready,
    false,
    "reasons cannot conceal existing unbound entries"
  );
  assert.equal(
    waived.issues.filter((issue) => issue.code === "unbound-note").length,
    2
  );
});

test("Missing card purposes and exact purpose duplication in Notes are not complete explanations", async (t) => {
  const { service, walk, check } = await fixture(t, { explanation: "" });
  assert.ok(
    (await check()).issues.some((issue) => issue.code === "missing-purpose")
  );
  const code = walk.steps[0].code;
  const purpose = "Computes the line total from the price and quantity.";
  await service.call("review_explanation", {
    walkthroughId: walk.id,
    stepId: "total",
    expectedRevision: walk.revision,
    sourceHash: code.hash,
    fileHash: code.fileHash,
    body: purpose,
    author: "Test",
    attachments: [],
  });
  let current = await service.call("get_walkthrough", { id: walk.id });
  current = await annotate(service, current);
  const block = current.steps[0].notes.find((note) => !note.variableName);
  await service.call("review_note", {
    walkthroughId: current.id,
    stepId: "total",
    noteId: block.id,
    expectedRevision: current.revision,
    sourceHash: code.hash,
    fileHash: code.fileHash,
    body: purpose,
    author: "Test",
    attachments: block.attachments,
  });
  current = await service.call("get_walkthrough", { id: current.id });
  const result = await check(current);
  assert.equal(result.ready, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "duplicate-purpose" && issue.noteId === block.id
    )
  );
});

test("Readback revisions cannot be reused after concurrent edits, and missing source is not ready", async (t) => {
  const { root, service, walk, check } = await fixture(t);
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "total",
    body: "Preserve this concurrent edit.",
    author: "Another reader",
  });
  await assert.rejects(check(walk), /Walkthrough changed/);
  const current = await service.call("get_walkthrough", { id: walk.id });
  fs.unlinkSync(path.join(root, "total.ts"));
  const result = await check(current);
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((issue) => issue.code === "source-unavailable"));
});

test("A legacy partial-identifier attachment cannot pass readiness even with a current file hash", async (t) => {
  const { root, service, walk, check } = await fixture(t);
  const current = await annotate(service, walk);
  await service.close(); // Alter only a stopped, isolated legacy fixture, never a running owner's store.
  const file = path.join(root, ".codepaths/workspace.json"),
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  const variable = state.paths[0].steps[0].notes.find(
    (note) => note.variableName
  );
  variable.variableName = "mount";
  variable.attachments = variable.attachments.map((range) => ({
    ...range,
    text: "mount",
    startColumn: range.startColumn + 1,
  }));
  fs.writeFileSync(file, JSON.stringify(state));
  const restarted = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => restarted.close());
  const result = await check(current);
  assert.equal(result.ready, false);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "invalid-attachment" && issue.noteId === variable.id
    )
  );
});

test("Empty guides cannot be certified and archived entries do not satisfy active explanation requirements", async (t) => {
  const { service, walk, check } = await fixture(t);
  const empty = await service.call("save_walkthrough", {
    title: "Unfinished",
    steps: [],
  });
  assert.equal((await check(empty)).issues[0].code, "empty-walkthrough");
  let current = await annotate(service, walk);
  const variable = current.steps[0].notes.find((note) => note.variableName),
    code = current.steps[0].code;
  await service.call("review_note", {
    walkthroughId: current.id,
    stepId: "total",
    noteId: variable.id,
    expectedRevision: current.revision,
    sourceHash: code.hash,
    fileHash: code.fileHash,
    author: "Test",
    body: variable.body,
    attachments: variable.attachments,
    archived: true,
  });
  current = await service.call("get_walkthrough", { id: current.id });
  assert.ok(
    (await check(current)).issues.some(
      (issue) => issue.code === "missing-variables"
    )
  );
  assert.equal(
    current.steps[0].notes.find((note) => note.id === variable.id).archived,
    true
  );
});

test("Standalone MCP initialization, tool guidance and the completed-guide result expose the authoring contract", async (t) => {
  const { root, service, walk } = await fixture(t);
  const current = await annotate(service, walk);
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "validate_walkthrough",
        arguments: {
          walkthroughId: current.id,
          expectedRevision: current.revision,
        },
      },
    },
  ];
  const result = await agentRun(
    root,
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n"
  );
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const policy = replies.find((m) => m.id === 1).result.instructions;
  const { walkthroughAuthoringInstructions } =
    await import("../dist/authoring-policy.mjs");
  assert.equal(policy, walkthroughAuthoringInstructions);
  for (const requirement of [
    "all three explanation homes",
    "nonempty",
    "variableName",
    "whole-identifier",
    "validate_walkthrough",
    "ready is true",
    "incomplete",
  ])
    assert.ok(policy.includes(requirement), requirement);
  const tools = replies.find((m) => m.id === 2).result.tools;
  assert.equal(
    tools.find((tool) => tool.name === "validate_walkthrough").annotations
      .readOnlyHint,
    true
  );
  assert.match(
    tools.find((tool) => tool.name === "add_note").description,
    /plain\/manual/
  );
  assert.match(
    tools.find((tool) => tool.name === "save_walkthrough").description,
    /does not create Notes/
  );
  const validation = replies.find((m) => m.id === 3).result;
  assert.ok(!validation.isError);
  assert.equal(JSON.parse(validation.content[0].text).ready, true);
  const cli = await agentRun(root, "", [
    "--call",
    "validate_walkthrough",
    "--args",
    JSON.stringify({
      walkthroughId: current.id,
      expectedRevision: current.revision,
    }),
  ]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ready, true);
});

test("An incomplete guide is a failed MCP/CLI completion check, not a green tool success", async (t) => {
  const { root, walk } = await fixture(t);
  const args = { walkthroughId: walk.id, expectedRevision: walk.revision };
  const result = await agentRun(
    root,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "validate_walkthrough", arguments: args },
    }) + "\n"
  );
  assert.equal(result.code, 0, result.stderr);
  const message = JSON.parse(result.stdout.trim());
  assert.equal(message.result.isError, true);
  assert.equal(JSON.parse(message.result.content[0].text).ready, false);
  const cli = await agentRun(root, "", [
    "--call",
    "validate_walkthrough",
    "--args",
    JSON.stringify(args),
  ]);
  assert.equal(cli.code, 1);
  assert.equal(JSON.parse(cli.stdout).ready, false);
});
