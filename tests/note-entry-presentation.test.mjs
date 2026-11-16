import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const result = await build({
  entryPoints: [
    new URL("../ui/note-presentation.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  jsx: "automatic",
  write: false,
  platform: "node",
  format: "esm",
});
const { NoteEntry, NoteTabButtons } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
const note = {
  id: "same-note",
  body: "**Actual** meaning",
  author: "Human",
  hash: "original",
  at: "now",
  variableName: "amount",
  attachments: [{ startLine: 7 }],
};
test("One shared entry preserves walkthrough Variable heading, line label and safe Markdown; actions remain an owner-supplied slot", () => {
  const html = renderToStaticMarkup(
    createElement(
      NoteEntry,
      { note, warning: createElement("span", null, "Source changed · review") },
      createElement("button", null, "Owner action")
    )
  );
  assert.match(
    html,
    /<h3><code>amount<\/code><small class="variable-location">Line 7<\/small><\/h3>/
  );
  assert.match(html, /<strong>Actual<\/strong>/);
  assert.match(html, /data-explanation-id="same-note"/);
  assert.match(html, /Owner action/);
  const readonly = renderToStaticMarkup(createElement(NoteEntry, { note }));
  assert.doesNotMatch(readonly, /<button/);
  assert.doesNotMatch(readonly, /Same source version|Original attachment/);
});
test("Shared tab buttons preserve Notes/Variables counts and active style without inventing Data/Flow or source authority", () => {
  const html = renderToStaticMarkup(
    createElement(NoteTabButtons, {
      tab: "variables",
      change: () => {},
      notes: [
        note,
        { ...note, id: "archived", archived: true },
        { ...note, id: "block", variableName: undefined },
      ],
    })
  );
  assert.match(html, /Notes · 1/);
  assert.match(html, /Variables · 1/);
  assert.match(html, /class="active" aria-pressed="true"/);
  assert.doesNotMatch(html, /Data at|Flow|Save/);
});
