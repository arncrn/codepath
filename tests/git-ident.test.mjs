import { test } from "node:test";
import assert from "node:assert/strict";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

test("Literal ident=set cannot hide a real edit by being interpreted as boolean ident", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "$Id$\n");
  f.git("add", "--", "part.ts");
  f.git("commit", "--quiet", "-m", "identity fixture");
  f.write(".gitattributes", "part.ts ident=set\n");
  f.write("part.ts", "$Id: changed $\n");
  assert.match(
    f.git("diff", "--no-ext-diff", "--no-textconv", "--", "part.ts"),
    /\+\$Id: changed \$/
  );
  const list = await allChanges(f.service);
  const file = list.files.find((file) => file.file === "part.ts");
  assert.ok(
    file,
    "Do not normalize away the real edit under a literal, non-boolean ident value"
  );
  assert.equal(
    file.status,
    "unavailable",
    "Ambiguous boolean/literal metadata must be unknown, not guessed"
  );
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  assert.match(view.unavailable, /ident/i);
});
