import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

async function view(f, query = { mode: "changes" }) {
  const list = await allChanges(f.service, query);
  return f.service.call("get_git_file", {
    listId: list.listId,
    fileId: list.files.find((file) => file.file === "part.ts").id,
  });
}
function note(v) {
  return {
    listId: v.listId,
    fileId: v.file.id,
    binding: v.binding,
    side: "after",
    expectedRevision: 0,
    body: "Must not be accepted",
    author: "Human",
    attachments: [],
  };
}
for (const mutation of ["disk", "index", "ref"])
  test(`A ${mutation} change while a real note request awaits Git refuses the write with no accepted metadata`, async (t) => {
    const f = await gitProject(t);
    if (mutation === "ref") {
      f.write("part.ts", "new commit\n");
      f.git("add", "--", "part.ts");
      f.git("commit", "--quiet", "-m", "alternate tip");
    }
    f.write("part.ts", "dirty saved\n");
    const v = await view(
      f,
      mutation === "ref"
        ? { mode: "compare", base: "refs/heads/equal", target: "WORKING_TREE" }
        : undefined
    );
    let settled = false;
    const pending = f.service
      .call("save_comparison_note", note(v))
      .finally(() => {
        settled = true;
      });
    // Attach refusal observer immediately so an early refusal cannot be unhandled.
    const refused = assert.rejects(pending, /changed/i);
    await delay(10);
    assert.equal(
      settled,
      false,
      "The actual public operation must still be awaited at mutation time."
    );
    if (mutation === "disk") f.write("part.ts", "intervening disk write\n");
    if (mutation === "index") f.git("add", "--", "part.ts");
    if (mutation === "ref") f.git("branch", "-f", "equal", "HEAD");
    await refused;
    assert.equal((await f.service.call("project_overview", {})).revision, 0);
    assert.equal(
      fs.existsSync(path.join(f.root, ".codepaths/workspace.json")),
      false
    );
  });

test("Owner close cancels and drains actual pending Git/note work before release; no deferred save or owned diff temporary survives", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "dirty saved\n");
  const v = await view(f);
  let settled = false;
  const pending = f.service
    .call("save_comparison_note", note(v))
    .finally(() => {
      settled = true;
    });
  const refused = assert.rejects(pending);
  await delay(10);
  assert.equal(settled, false);
  await f.service.close();
  await refused;
  assert.equal(
    fs.existsSync(path.join(f.root, ".codepaths/workspace.json")),
    false
  );
  const children = execFileSync("ps", ["-axo", "ppid=,comm="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (line) =>
        Number(line.trim().split(/\s+/)[0]) === process.pid &&
        /\/git$/.test(line)
    );
  assert.deepEqual(children, []);
  assert.deepEqual(
    fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(`codepath-diff-${process.pid}-`)),
    []
  );
  await f.reopen();
  assert.equal((await f.service.call("project_overview", {})).revision, 0);
});
