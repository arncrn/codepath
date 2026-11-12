import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { gitProject } from "./fixtures/git-project.mjs";

test("A repository-local TMPDIR cannot turn read-only inspection into worktree temporary writes", async (t) => {
  const f = await gitProject(t);
  fs.writeFileSync(path.join(f.root, "part.ts"), "dirty fixture\n");
  const page = await f.service.call("list_git_changes", {
    query: { mode: "changes" },
  });
  const previous = process.env.TMPDIR;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  process.env.TMPDIR = f.root;
  const before = fs.statSync(f.root).mtimeMs;
  await assert.rejects(
    f.service.call("get_git_file", {
      listId: page.listId,
      fileId: page.files[0].id,
    }),
    /outside the repository/
  );
  assert.equal(fs.statSync(f.root).mtimeMs, before);
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.startsWith("codepath-diff-")),
    false
  );
});

function populateIndex(f, count) {
  const oid = f.git("rev-parse", "HEAD:part.ts").trim();
  const records = Array.from(
    { length: count },
    (_, index) =>
      `100644 ${oid}\tfixture-${String(index).padStart(6, "0")}/${"x".repeat(220)}\n`
  ).join("");
  f.gitInput(records, "update-index", "--index-info");
}
test("Oversized real Git metadata is refused completely, never truncated into a first-N file list", async (t) => {
  const f = await gitProject(t);
  populateIndex(f, 120000);
  const index = path.join(f.root, ".git/index");
  const before = fs.statSync(index).mtimeMs;
  await assert.rejects(
    f.service.call("list_git_changes", { query: { mode: "changes" } }),
    /exceeds.*budget/
  );
  assert.equal(fs.statSync(index).mtimeMs, before);
  assert.equal(
    fs.existsSync(path.join(f.root, ".codepaths/workspace.json")),
    false
  );
});

test("A stopped owned Git child hits the actual runtime deadline and drains before comparison returns", async (t) => {
  const f = await gitProject(t);
  populateIndex(f, 30000);
  const start = Date.now();
  const pending = f.service
    .call("list_git_changes", { query: { mode: "changes" } })
    .then(
      () => null,
      (error) => error
    );
  // The fixture's large ls-files output fills a pipe while ps runs, giving us a
  // real owned subprocess to stop. Never signal a PID from another parent.
  let stopped;
  for (let attempt = 0; !stopped && attempt < 100; attempt++) {
    await delay(1);
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    }).split("\n");
    const row = rows.find((line) => {
      const [pid, ppid, ...command] = line.trim().split(/\s+/);
      return (
        Number(ppid) === process.pid &&
        Number(pid) > 0 &&
        command[0]?.endsWith("/git") &&
        command.includes("ls-files")
      );
    });
    if (!row) continue;
    const pid = Number(row.trim().split(/\s+/)[0]);
    try {
      process.kill(pid, "SIGSTOP");
      stopped = pid;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  assert.ok(
    stopped,
    "Must observe and stop this test process's actual Git child."
  );
  const error = await pending;
  assert.match(
    error?.message ?? "Operation unexpectedly succeeded",
    /timed out/
  );
  assert.ok(Date.now() - start >= 4500);
  assert.throws(() => process.kill(stopped, 0), { code: "ESRCH" });
  assert.equal(
    fs.existsSync(path.join(f.root, ".codepaths/workspace.json")),
    false
  );
});
