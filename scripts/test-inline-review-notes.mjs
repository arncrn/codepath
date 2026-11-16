import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { verifyInlineReviewNotes } from "./inline-review-notes-check.mjs";
import { readVariable } from "./unified-review-check.mjs";
const cleanup = [],
  f = await gitProject({ after: (c) => cleanup.push(c) });
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1550, height: 1000 },
    }),
    errors = [],
    writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/call")) {
      const { name } = r.postDataJSON();
      if (name !== "project_overview" && !/^(get_|list_|check_)/.test(name))
        writes.push(name);
    }
  });
  await page.goto(f.service.url);
  const { saved } = await verifyInlineReviewNotes(page, f);
  const wp = path.join(f.root, ".codepaths/workspace.json"),
    before = fs.readFileSync(wp);
  fs.renameSync(
    path.join(f.root, ".git"),
    path.join(f.root, "owned-git-hidden")
  );
  try {
    await page.reload();
    await page.locator(`[data-comparison-path="${saved.id}"]`).first().click();
    const notes = page.locator('[data-unmatched-explanation="first"]');
    await notes.scrollIntoViewIfNeeded();
    await notes
      .getByText("Inline first after block behavior", { exact: true })
      .waitFor();
    await readVariable(notes, "Inline first after named amount");
    await notes
      .locator('[data-explanation-side="after"]')
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .click();
    assert.equal(await page.locator("#current-changes pre").count(), 0);
    assert.deepEqual(fs.readFileSync(wp), before);
    assert.deepEqual(
      writes,
      [],
      "Displaying notes does not write progress or annotations"
    );
    const note = notes
      .locator("[data-visible-note]")
      .filter({ hasText: "Inline first after block behavior" });
    await note
      .getByRole("button", { name: "Delete note", exact: true })
      .click();
    await note
      .getByRole("button", { name: "Confirm delete note", exact: true })
      .click();
    await note.waitFor({ state: "detached" });
    const read = await f.service.call("get_comparison_walkthrough", {
      id: saved.id,
    });
    assert.ok(
      read.steps[0].annotations.notes.some(
        (n) => n.body === "Inline first after block behavior" && n.archived
      )
    );
    assert.deepEqual(
      read.steps.map(({ annotations: _annotations, ...s }) => s),
      saved.steps.map(({ annotations: _annotations, ...s }) => s),
      "Deletion keeps original source identity and history even without Git"
    );
  } finally {
    fs.renameSync(
      path.join(f.root, "owned-git-hidden"),
      path.join(f.root, ".git")
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, ["delete_walkthrough_comparison_note"]);
  console.log(
    "PASS unavailable Git still displays annotations with honest original-source labels, no alternate code mode; read-only display has no writes and explicit deletion remains source independent."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
