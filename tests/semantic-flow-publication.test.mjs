import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";
import {
  plainLanguageRule,
  walkthroughAuthoringInstructions,
} from "../dist/authoring-policy.mjs";
import {
  prepareSemanticFlowPublication,
  publishSemanticFlow,
} from "../scripts/author-semantic-flow.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-flow-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "ui/walkthrough-flow.tsx",
    "ui/notes.tsx",
    "walkthrough-flow.mts",
    "workspace.mts",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(file, path.join(root, file));
  }
  fs.writeFileSync(path.join(root, "legacy.mjs"), "export const old = 1;\n");
  const w = openWorkspace(root);
  const walk = w.invoke("save_walkthrough", {
    id: "review-ticket-28",
    title: "Original guide retained",
    steps: [
      {
        id: "original",
        title: "Legacy card",
        source: { file: "legacy.mjs", startLine: 1, endLine: 1 },
        explanation: "Original purpose retained",
      },
    ],
  });
  w.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: "original",
    body: "Original note retained",
    author: "Original",
  });
  const client = { call: async (name, args) => w.invoke(name, args) };
  return { w, client };
}
test("Real-guide publication preflights actual application source without writes, then guarded tools add all three homes and nonlinear Flow without rewriting originals", async (t) => {
  const { w, client } = fixture(t);
  const original = w.invoke("get_walkthrough", { id: "review-ticket-28" });
  const before = fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8");
  const plan = await prepareSemanticFlowPublication(client);
  assert.equal(
    fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8"),
    before
  );
  assert.equal(
    plan.additions.find((a) => a.step.id === "semantic-flow-project").step
      .title,
    "Check whether the linked code has changed"
  );
  assert.equal(
    plan.additions.find((a) => a.step.id === "semantic-flow-project")
      .variableBody,
    "The boxes that failed the source checks. An empty list means every box still matches its recorded code."
  );
  assert.equal(
    plan.specs.find((n) => n[0] === "hasgraph")[3],
    "Is there a saved diagram?"
  );
  assert.equal(
    plan.specs.find((n) => n[0] === "bindings")[3],
    "Did any source check fail?"
  );
  assert.deepEqual(
    plan.edges
      .filter((e) => e.from === "hasgraph")
      .map(({ to, kind }) => ({ to, kind })),
    [
      { to: "bindings", kind: "true" },
      { to: "absent", kind: "false" },
    ],
    "The positive saved-diagram question keeps its matching true/false destinations"
  );
  assert.deepEqual(
    plan.edges
      .filter((e) => e.from === "bindings")
      .map(({ to, kind }) => ({ to, kind })),
    [
      { to: "stale", kind: "true" },
      { to: "generate", kind: "false" },
    ],
    "A failed source check blocks display, not the opposite"
  );
  const { walkthrough: after, readiness } = await publishSemanticFlow(
    client,
    plan
  );
  assert.deepEqual(after.steps[0], original.steps[0]);
  assert.equal(after.title, original.title);
  assert.equal(after.flowState.status, "current");
  assert.ok(after.flow.edges.some((e) => e.kind === "recursion"));
  assert.ok(after.flow.edges.some((e) => e.kind === "loop"));
  assert.ok(after.flow.edges.some((e) => e.kind === "unresolved"));
  for (const a of plan.additions) {
    const step = after.steps.find((s) => s.id === a.step.id);
    assert.ok(step.explanation);
    assert.equal(step.notes.length, 2);
    assert.ok(step.notes.every((n) => n.attachments.length === 1));
    assert.ok(step.notes.some((n) => n.variableName));
  }
  assert.ok(
    readiness.issues.every((i) => i.stepId === "original"),
    "New cards have valid three-home bindings; old content is not blindly reviewed"
  );
});
test("Shared author instructions teach separate plain-language homes and honest decision labels without dropping source safeguards", () => {
  assert.ok(walkthroughAuthoringInstructions.includes(plainLanguageRule));
  for (const text of [
    "what the code does",
    "selected statements or call",
    "what its value represents",
    "never copy one side",
  ])
    assert.ok(plainLanguageRule.includes(text), text);
  for (const text of [
    "true/yes",
    "false/no",
    "nonempty, exact current source attachments",
    "expectedRevision",
    "120 nodes",
    "unresolved",
  ])
    assert.ok(walkthroughAuthoringInstructions.includes(text), text);
});
test("A source change after the last reviewed Note must not receive fresh Flow hashes", async (t) => {
  for (const afterNote of [6, 16]) {
    const { w, client } = fixture(t);
    const plan = await prepareSemanticFlowPublication(client);
    let notes = 0;
    const delayed = {
      call: async (name, args) => {
        const reply = await client.call(name, args);
        if (name === "add_reviewed_note" && ++notes === afterNote) {
          const file = path.join(w.root, "ui/walkthrough-flow.tsx");
          const source = fs.readFileSync(file, "utf8");
          assert.ok(source.includes("tags.has(child.localName)"));
          fs.writeFileSync(
            file,
            source.replace(
              "tags.has(child.localName)",
              "!tags.has(child.localName)"
            )
          );
        }
        return reply;
      },
    };
    await assert.rejects(
      publishSemanticFlow(delayed, plan),
      /source changed during authoring/
    );
    const after = w.invoke("get_walkthrough", { id: plan.id });
    assert.equal(
      after.flow,
      undefined,
      "Do not bless old reviewed edges with the changed source fingerprint"
    );
    assert.equal(after.steps[0].explanation, "Original purpose retained");
    assert.equal(after.steps[0].notes[0].body, "Original note retained");
    assert.equal(
      after.steps.length,
      9,
      "Already authored homes remain as explicit incomplete work"
    );
  }
});

test("A source mutation after the final read is rejected by public Flow admission, not rebound to newer bytes", async (t) => {
  const { w, client } = fixture(t);
  const plan = await prepareSemanticFlowPublication(client);
  let notes = 0;
  let changed = false;
  const racing = {
    call: async (name, args) => {
      const reply = await client.call(name, args);
      if (name === "add_reviewed_note") notes++;
      if (name === "get_walkthrough" && notes === 16 && !changed) {
        changed = true;
        const file = path.join(w.root, "ui/walkthrough-flow.tsx");
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, "utf8")
            .replace("tags.has(child.localName)", "!tags.has(child.localName)")
        );
      }
      return reply;
    },
  };
  await assert.rejects(
    publishSemanticFlow(racing, plan),
    /source or linked cards changed/
  );
  assert.equal(changed, true);
  const after = w.invoke("get_walkthrough", { id: plan.id });
  assert.equal(after.flowState.status, "absent");
  assert.equal(after.steps[0].notes[0].body, "Original note retained");
});

test("A guide or source change after parent review blocks publication before any addition is saved", async (t) => {
  const { w, client } = fixture(t);
  const plan = await prepareSemanticFlowPublication(client);
  fs.appendFileSync(
    path.join(w.root, "ui/notes.tsx"),
    "\n// changed after review\n"
  );
  const before = fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8");
  await assert.rejects(
    publishSemanticFlow(client, plan),
    /source changed since plan review/
  );
  assert.equal(
    fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8"),
    before
  );
});
