import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startProjectService } from "../dist/service.mjs";
import { gitEnvironment } from "./fixtures/git-project.mjs";

export const beforeContent = "export const amount = 2 + 3;\n";
export const afterContent = "export const amount = 2 * 3;\n";
export function reviewInput() {
  const side = (content, provenance) => ({
    file: "total.ts",
    content,
    provenance,
    startLine: 1,
    endLine: 1,
    purpose: "Computes the exported amount.",
    notes: [
      {
        body: "Evaluate the arithmetic expression before exporting its result.",
        startLine: 1,
        endLine: 1,
      },
    ],
    variables: [
      {
        name: "amount",
        body: "The exported arithmetic result.",
        occurrences: [{ line: 1, startColumn: 13 }],
      },
    ],
  });
  return {
    id: "arithmetic",
    title: "Multiply rather than add",
    cards: [
      {
        id: "amount",
        title: "Compute amount",
        beforeBehavior: "Adds 2 and 3, producing 5.",
        afterBehavior: "Multiplies 2 and 3, producing 6.",
        reason: "The amount must represent a product, not a sum.",
        before: side(
          beforeContent,
          "Explicit original source supplied by the author; no Git baseline."
        ),
        after: side(
          afterContent,
          "Explicit proposed source, checked against the current saved file."
        ),
      },
    ],
  };
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-review-"));
  fs.writeFileSync(path.join(root, "total.ts"), afterContent);
  const service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, service };
}

test("Explicit before/after review works without Git and returns explanations, attached Notes and named Variables", async (t) => {
  const { root, service } = await fixture(t);
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
  const input = reviewInput();
  const review = await service.call("create_change_review", input);
  assert.equal(review.cards[0].before.content, beforeContent);
  assert.equal(review.cards[0].after.content, afterContent);
  assert.match(review.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(review.cards[0].before.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(review.cards[0].beforeBehavior, input.cards[0].beforeBehavior);
  assert.equal(review.cards[0].afterBehavior, input.cards[0].afterBehavior);
  assert.equal(review.cards[0].reason, input.cards[0].reason);
  assert.equal(
    review.cards[0].before.provenance,
    input.cards[0].before.provenance
  );
  assert.equal(
    review.cards[0].before.notes[0].attachments[0].text,
    "export const amount = 2 + 3;"
  );
  assert.equal(review.cards[0].after.notes[1].variableName, "amount");
  assert.equal(review.live[0].status, "matches-after");
  input.cards[0].before.content = "mutated caller";
  assert.equal(
    (await service.call("get_change_review", { id: review.id })).cards[0].before
      .content,
    beforeContent
  );
  assert.equal(
    (await service.call("list_change_reviews", {}))[0].id,
    review.id
  );
});

test("Snapshots survive live drift, deletion and service restart without changing fingerprints or persisted bytes", async (t) => {
  const { root, service } = await fixture(t);
  const saved = await service.call("create_change_review", reviewInput());
  const file = path.join(root, ".codepaths/workspace.json");
  const bytes = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(root, "total.ts"), "export const amount = 99;\n");
  let current = await service.call("get_change_review", { id: saved.id });
  assert.equal(current.live[0].status, "changed");
  assert.notEqual(
    current.live[0].fingerprint,
    saved.cards[0].after.fingerprint
  );
  assert.deepEqual(current.cards, saved.cards);
  assert.equal(current.fingerprint, saved.fingerprint);
  fs.unlinkSync(path.join(root, "total.ts"));
  current = await service.call("get_change_review", { id: saved.id });
  assert.equal(current.live[0].status, "unavailable");
  assert.deepEqual(current.cards, saved.cards);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  await service.close();
  const restarted = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => restarted.close());
  current = await restarted.call("get_change_review", { id: saved.id });
  assert.deepEqual(current.cards, saved.cards);
  assert.equal(current.live[0].status, "unavailable");
});

test("Incomplete, invented, stale and invalid review inputs cannot create or replace snapshots", async (t) => {
  const { root, service } = await fixture(t);
  const invalid = [
    [
      (v) => {
        delete v.cards[0].before.content;
      },
      /Explicit review source/,
    ],
    [
      (v) => {
        v.cards[0].after.content = beforeContent;
      },
      /must differ/,
    ],
    [
      (v) => {
        v.cards[0].after.content += "// not saved";
      },
      /After source changed/,
    ],
    [
      (v) => {
        v.cards[0].reason = " ";
      },
      /text is missing/,
    ],
    [
      (v) => {
        v.cards[0].before.provenance = "";
      },
      /text is missing/,
    ],
    [
      (v) => {
        v.cards[0].before.notes = [];
      },
      /notes require attachments/,
    ],
    [
      (v) => {
        v.cards[0].before.variables[0].name = "mount";
        v.cards[0].before.variables[0].occurrences[0].startColumn = 14;
      },
      /whole identifier/,
    ],
    [
      (v) => {
        v.cards[0].before.notes[0].endLine = 500;
      },
      /attachment/,
    ],
    [
      (v) => {
        v.cards[0].before.file = "../outside.ts";
      },
      /filename/,
    ],
    [
      (v) => {
        v.cards.push(v.cards[0]);
      },
      /Duplicate/,
    ],
    [
      (v) => {
        v.cards[0].before.content = "x".repeat(129 * 1024);
      },
      /128 KiB/,
    ],
  ];
  for (const [mutate, error] of invalid) {
    const input = reviewInput();
    mutate(input);
    await assert.rejects(service.call("create_change_review", input), error);
    assert.deepEqual(await service.call("list_change_reviews", {}), []);
  }
  const saved = await service.call("create_change_review", reviewInput());
  const file = path.join(root, ".codepaths/workspace.json"),
    bytes = fs.readFileSync(file, "utf8");
  await assert.rejects(
    service.call("create_change_review", reviewInput()),
    /already exists/
  );
  await assert.rejects(
    service.call("get_change_review", { id: "missing" }),
    /not found/
  );
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(
    (await service.call("get_change_review", { id: saved.id })).fingerprint,
    saved.fingerprint
  );
});

test("Existing ordinary walkthroughs, draft/manual notes, IDs and history are independent of review capture", async (t) => {
  const { root, service } = await fixture(t);
  const walk = await service.call("save_walkthrough", {
    id: "arithmetic",
    title: "Draft",
    steps: [
      {
        id: "step",
        title: "Amount",
        source: { file: "total.ts", startLine: 1, endLine: 1 },
      },
    ],
  });
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "step",
    body: "Keep my manual note.",
    author: "Reader",
  });
  let original = await service.call("get_walkthrough", { id: walk.id });
  const code = original.steps[0].code;
  await service.call("review_explanation", {
    walkthroughId: original.id,
    stepId: "step",
    expectedRevision: original.revision,
    sourceHash: code.hash,
    fileHash: code.fileHash,
    body: "A deliberately reviewed ordinary purpose.",
    author: "Reader",
    attachments: [],
  });
  original = await service.call("get_walkthrough", { id: walk.id });
  assert.equal(original.steps[0].explanationHistory.length, 1);
  await service.call("create_change_review", reviewInput());
  assert.deepEqual(
    await service.call("get_walkthrough", { id: walk.id }),
    original
  );
  await service.call("delete_walkthrough", {
    id: walk.id,
    expectedRevision: original.revision,
  });
  assert.equal(
    (await service.call("get_change_review", { id: "arithmetic" })).cards[0]
      .before.content,
    beforeContent
  );
  await service.close();
  const stateFile = path.join(root, ".codepaths/workspace.json");
  const legacy = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  delete legacy.changeReviews;
  fs.writeFileSync(stateFile, JSON.stringify(legacy));
  const restarted = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.call("list_change_reviews", {}), []);
});

test("Explicit inapplicability reasons are retained, and failed persistence does not expose an accepted review", async (t) => {
  const { root, service } = await fixture(t);
  const input = reviewInput();
  for (const side of [input.cards[0].before, input.cards[0].after]) {
    side.variables = [];
    side.notApplicable = {
      variables:
        "This selection focuses on arithmetic, with no separate variable explanation in this fixture.",
    };
  }
  const file = path.join(
    root,
    ".codepaths/workspace.json." + process.pid + ".tmp"
  );
  fs.mkdirSync(file);
  await assert.rejects(service.call("create_change_review", input), /EISDIR/);
  assert.deepEqual(await service.call("list_change_reviews", {}), []);
  fs.rmdirSync(file);
  const saved = await service.call("create_change_review", input);
  assert.equal(
    saved.cards[0].before.notApplicable.variables,
    input.cards[0].before.notApplicable.variables
  );
});

test("An unborn Git repository also accepts explicitly supplied original source without HEAD", async (t) => {
  const { root, service } = await fixture(t);
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "init", "--quiet", root],
    { env: gitEnvironment, stdio: "pipe" }
  );
  assert.throws(() =>
    execFileSync(
      "/usr/bin/git",
      ["-C", root, "rev-parse", "--verify", "HEAD"],
      {
        env: gitEnvironment,
        stdio: "pipe",
      }
    )
  );
  const saved = await service.call("create_change_review", reviewInput());
  assert.equal(saved.cards[0].before.content, beforeContent);
});

test("Snapshot integrity is checked on reopening rather than silently accepting altered source", async (t) => {
  const { root, service } = await fixture(t);
  await service.call("create_change_review", reviewInput());
  await service.close();
  const file = path.join(root, ".codepaths/workspace.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.changeReviews[0].cards[0].before.content = "Altered source";
  fs.writeFileSync(file, JSON.stringify(state));
  await assert.rejects(
    startProjectService(root, { assetsRoot: path.resolve("dist") }),
    /fingerprint mismatch/
  );
});

test("Review capture and reopening accept more than eight pairs within the byte budgets", async (t) => {
  const { root, service } = await fixture(t);
  for (const count of [9, 32]) {
    const input = reviewInput();
    input.id = "pairs-" + count;
    input.cards = Array.from({ length: count }, (_, index) => ({
      ...structuredClone(input.cards[0]),
      id: "location-" + index,
      title: "Location " + (index + 1),
    }));
    const saved = await service.call("create_change_review", input);
    assert.equal(saved.cards.length, count);
    assert.equal(saved.cards.at(-1).id, "location-" + (count - 1));
    assert.ok(saved.live.every((card) => card.status === "matches-after"));
  }
  const { tools } = await import("../dist/tools.mjs");
  const capture = tools.find((tool) => tool.name === "create_change_review");
  assert.equal(capture.inputSchema.properties.cards.maxItems, undefined);
  await service.close();
  const reopened = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.call("get_change_review", { id: "pairs-9" })).cards.length,
    9
  );
  assert.equal(
    (await reopened.call("get_change_review", { id: "pairs-32" })).cards.length,
    32
  );
});

test("Removing the pair cap retains nonempty capture and both byte-budget refusals", async (t) => {
  const { root, service } = await fixture(t);
  await assert.rejects(
    service.call("create_change_review", { ...reviewInput(), cards: [] }),
    /at least one/
  );
  const requestTooLarge = reviewInput();
  requestTooLarge.cards = Array.from({ length: 140 }, (_, index) => ({
    ...structuredClone(requestTooLarge.cards[0]),
    id: "location-" + index,
    reason: "r".repeat(4000),
  }));
  await assert.rejects(
    service.call("create_change_review", requestTooLarge),
    /Review exceeds 512 KiB/
  );

  const storedTooLarge = reviewInput();
  const padding = "// " + "x".repeat(1000) + "\n";
  storedTooLarge.cards[0].before.content += padding;
  storedTooLarge.cards[0].after.content += padding;
  fs.writeFileSync(
    path.join(root, "total.ts"),
    storedTooLarge.cards[0].after.content
  );
  storedTooLarge.cards = Array.from({ length: 120 }, (_, index) => ({
    ...structuredClone(storedTooLarge.cards[0]),
    id: "location-" + index,
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(storedTooLarge)) < 512 * 1024,
    "Input fits; the expanded saved representation must be bounded separately."
  );
  await assert.rejects(
    service.call("create_change_review", storedTooLarge),
    /Captured review exceeds 512 KiB/
  );
  assert.deepEqual(await service.call("list_change_reviews", {}), []);
});
