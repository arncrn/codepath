import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

test("100k real staged deletion candidates yield to the service event loop before the first bounded page", async (t) => {
  const f = await gitProject(t);
  const empty = f.gitInput("", "hash-object", "-w", "--stdin").trim();
  const records = Array.from(
    { length: 100000 },
    (_, i) => `100644 blob ${empty}\tdeleted-${String(i).padStart(6, "0")}\n`
  ).join("");
  const kept = [".gitignore", "part.ts"]
    .map(
      (name) =>
        `100644 blob ${f.git("rev-parse", `HEAD:${name}`).trim()}\t${name}\n`
    )
    .join("");
  const tree = f.gitInput(kept + records, "mktree").trim();
  const commit = f
    .git("commit-tree", tree, "-p", "HEAD", "-m", "owned bulk fixture")
    .trim();
  f.git("update-ref", "refs/heads/main", commit);
  let last = performance.now(),
    lag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last);
    last = now;
  }, 10);
  const start = performance.now();
  let page, failure;
  try {
    page = await f.service.call("list_git_changes", {
      query: { mode: "changes" },
    });
  } catch (error) {
    failure = error;
  } finally {
    await delay(20);
    clearInterval(timer);
  }
  t.diagnostic(
    `first page ${Math.round(performance.now() - start)} ms; maximum timer gap ${Math.round(lag)} ms`
  );
  assert.ok(lag < 1000, `shared service blocked for ${Math.round(lag)} ms`);
  assert.equal(failure, undefined);
  assert.equal(page.complete, false);
  assert.ok(page.files.length > 0 && page.files.length <= 100);
  assert.equal(page.files[0].file, "deleted-000000");
  assert.equal(page.files[0].status, "deleted");
  const next = await f.service.call("list_git_changes", {
    query: { mode: "changes" },
    cursor: page.nextCursor,
  });
  assert.equal(next.complete, false);
  assert.ok(next.files[0].file > page.files.at(-1).file);
  // Closing with a new bulk request still drains its owned preprocessing/query.
  const pending = f.service
    .call("list_git_changes", { query: { mode: "changes" } })
    .catch(() => null);
  await delay(10);
  await f.service.close();
  await pending;
});

test("Ambiguous identical-content renames consume each addition once in stable filename order", async (t) => {
  const f = await gitProject(t);
  for (const name of ["old-a", "old-b", "old-c"])
    f.write(name, "same fixture\n");
  f.git("add", "--", "old-a", "old-b", "old-c");
  f.git("commit", "--quiet", "-m", "owned ambiguity fixture");
  f.git("rm", "--", "old-a", "old-b", "old-c");
  for (const name of ["new-a", "new-b"]) f.write(name, "same fixture\n");
  f.git("add", "--", "new-a", "new-b");
  const list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map((x) => [x.file, x.oldFile, x.status]),
    [
      ["new-a", "old-a", "renamed"],
      ["new-b", "old-b", "renamed"],
      ["old-c", undefined, "deleted"],
    ]
  );
});
