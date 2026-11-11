import assert from "node:assert/strict";

// Shared actual-UI check: a Chrome Page or a disposable native webview Frame,
// plus the public feature operations of that UI's real owning service.
export async function verifyMarkdown(
  page,
  call,
  checkLink = async () => {},
  reopenNative
) {
  const original = await page
    .locator("#paths button.selected")
    .getAttribute("data-path");
  let walk = await call("save_walkthrough", {
    title: "Markdown explanations fixture",
    steps: [
      {
        id: "markdown",
        title: "Markdown",
        source: { file: "authoring.ts", symbol: "calculate" },
        explanation: "**Card purpose stays plain**",
      },
    ],
  });
  const native = await page.evaluate(
    () => globalThis.CODEPATH_CONFIG?.host === "vscode"
  );
  if (native) {
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    assert.match(csp, /script-src 'nonce-[a-f0-9]+';/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|command:/);
  }
  const code = walk.steps[0].code;
  const body = [
    "### testing 2",
    "[hmm](http://example.com)",
    "~testing~",
    "`oooo`",
    "",
    "# Heading one",
    "## Heading two",
    "#### Heading four",
    "##### Heading five",
    "###### Heading six",
    "",
    "~~double strike~~",
    "",
    "- [x] Checked task",
    "- [ ] Unchecked task",
    "",
    "A **strong** and *emphasized* paragraph with `amount < 2 && ready`.",
    "",
    "Another paragraph.",
    "",
    "- First item",
    "- Second item",
    "",
    "1. Ordered first",
    "2. Ordered second",
    "",
    "```ts",
    '<script>alert("code is text")</script>',
    "const amount = 2 < 3 && true;",
    "```",
  ].join("\n");
  async function add(variable) {
    const added = await call("add_reviewed_note", {
      walkthroughId: walk.id,
      stepId: "markdown",
      expectedRevision: walk.revision,
      sourceHash: code.hash,
      fileHash: code.fileHash,
      body,
      author: "Markdown fixture",
      ...(variable ? { variableName: "amount" } : {}),
      attachments: [
        {
          file: code.file,
          fileHash: code.fileHash,
          startLine: 2,
          endLine: 2,
          startColumn: variable ? 8 : 0,
          endColumn: variable ? 14 : code.lines[1].length,
          text: variable ? "amount" : code.lines[1],
        },
      ],
    });
    walk = await call("get_walkthrough", { id: walk.id });
    return added;
  }
  const block = await add(false);
  const variable = await add(true);
  await page.locator(`#paths [data-path="${walk.id}"]`).click();
  await page.locator('.code-card[data-step="markdown"]').waitFor();
  for (const [tab, note] of [
    ["notes", block],
    ["variables", variable],
  ]) {
    await page.locator(`#${tab}-tab`).click();
    const entry = page.locator(`[data-explanation-id="${note.id}"]`);
    const rendered = entry.locator(".markdown-body");
    assert.equal(
      await rendered.locator("h3").count(),
      1,
      "The user's ### heading must render as h3, not literal Markdown"
    );
    assert.equal(await rendered.locator("h3").textContent(), "testing 2");
    assert.deepEqual(await entry.locator("del").allTextContents(), [
      "testing",
      "double strike",
    ]);
    for (const level of [1, 2, 4, 5, 6])
      assert.equal(await rendered.locator(`h${level}`).count(), 1);
    assert.ok(
      await rendered
        .locator("h3")
        .evaluate(
          (node) =>
            parseFloat(globalThis.getComputedStyle(node).fontSize) >
            parseFloat(globalThis.getComputedStyle(node.parentElement).fontSize)
        )
    );
    assert.match(
      await entry
        .locator("del")
        .first()
        .evaluate(
          (node) => globalThis.getComputedStyle(node).textDecorationLine
        ),
      /line-through/
    );
    assert.equal(await entry.locator("input").count(), 0);
    assert.equal(
      await entry
        .getByRole("link", { name: "hmm", exact: true })
        .getAttribute("href"),
      "http://example.com/"
    );
    assert.equal(await entry.locator("strong").textContent(), "strong");
    assert.equal(await entry.locator("em").textContent(), "emphasized");
    assert.deepEqual(await entry.locator("p code").allTextContents(), [
      "oooo",
      "amount < 2 && ready",
    ]);
    assert.deepEqual(await entry.locator("ul > li").allTextContents(), [
      "[x] Checked task",
      "[ ] Unchecked task",
      "First item",
      "Second item",
    ]);
    assert.deepEqual(await entry.locator("ol > li").allTextContents(), [
      "Ordered first",
      "Ordered second",
    ]);
    assert.equal(
      await entry.locator("pre code").textContent(),
      '<script>alert("code is text")</script>\nconst amount = 2 < 3 && true;'
    );
    assert.equal(await entry.locator("script").count(), 0);
    assert.ok((await entry.locator("p").count()) >= 2);
  }
  assert.equal(
    await page.locator(".reason p").textContent(),
    "**Card purpose stays plain**"
  );
  assert.equal(await page.locator(".reason strong").count(), 0);
  assert.deepEqual(
    await page.locator("code[data-source-line]").allTextContents(),
    code.lines
  );
  assert.equal(
    await page.locator(".code img, .code script, .code iframe").count(),
    0
  );
  const malicious = [
    "<script>globalThis.__markdownPwn = true</script>",
    "",
    '<img src="https://invalid.example/raw" onerror="globalThis.__markdownPwn = true">',
    '<iframe src="https://invalid.example/frame"></iframe>',
    '<style>@import "https://invalid.example/style";</style>',
    '<a href="command:workbench.action.closeWindow" onclick="globalThis.__markdownPwn = true">raw link</a>',
    "",
    "![remote image](https://invalid.example/image)",
    "![data image](data:image/svg+xml;base64,PHN2Zz4=)",
    "",
    '[safe HTTPS](https://example.invalid/docs?q=1&v=2 "Docs") and [safe HTTP](http://example.invalid/docs).',
    "",
    "[script](javascript:alert%281%29) [mixed](JaVaScRiPt:alert%281%29)",
    "[encoded](javascript&#58;alert%281%29) [entity](jav&#x61;script:alert%281%29)",
    "[data](data:text/html,test) [file](file:///tmp/secret) [command](command:workbench.action.closeWindow)",
    "[vscode](vscode://settings/editor.fontSize) [relative](/api/state) [protocol-relative](//invalid.example/resource)",
    "[vbscript](vbscript:msgbox%281%29) [credentials](https://user:pass@example.invalid/)",
    "",
    '`<img src="https://invalid.example/inline-code">`',
  ].join("\n");
  const underlyingPage = typeof page.page === "function" ? page.page() : page;
  const resources = [],
    dialogs = [];
  const onRequest = (request) => {
    if (/https?:\/\/[^/]*\.invalid\//.test(request.url()))
      resources.push(request.url());
  };
  const onDialog = async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  };
  underlyingPage.on("request", onRequest);
  underlyingPage.on("dialog", onDialog);
  try {
    for (const [tab, note] of [
      ["notes", block],
      ["variables", variable],
    ]) {
      walk = await call("get_walkthrough", { id: walk.id });
      await call("review_note", {
        walkthroughId: walk.id,
        stepId: "markdown",
        noteId: note.id,
        expectedRevision: walk.revision,
        sourceHash: code.hash,
        fileHash: code.fileHash,
        body: malicious,
        author: "Untrusted Markdown fixture",
        attachments: note.attachments,
      });
      await page.locator(`#${tab}-tab`).click();
      const entry = page.locator(`[data-explanation-id="${note.id}"]`);
      await entry.getByText("remote image", { exact: false }).waitFor();
      assert.deepEqual(
        await entry.locator("a").evaluateAll((links) =>
          links.map((link) => ({
            text: link.textContent,
            href: link.getAttribute("href"),
            target: link.target,
            rel: link.rel,
          }))
        ),
        [
          {
            text: "safe HTTPS",
            href: "https://example.invalid/docs?q=1&v=2",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          {
            text: "safe HTTP",
            href: "http://example.invalid/docs",
            target: "_blank",
            rel: "noopener noreferrer",
          },
        ]
      );
      assert.equal(
        await entry
          .locator(
            "script, img, iframe, style, svg, object, embed, form, input"
          )
          .count(),
        0
      );
      assert.equal(
        await entry
          .locator("[onclick], [onerror], [src], [srcdoc], [style]")
          .count(),
        0
      );
      assert.match(
        await entry.innerText(),
        /<script>globalThis\.__markdownPwn = true<\/script>/
      );
      assert.equal(
        await entry.locator("p code").textContent(),
        '<img src="https://invalid.example/inline-code">'
      );
      assert.equal(
        await page.evaluate(() => globalThis.__markdownPwn),
        undefined
      );
    }
    assert.deepEqual(
      resources,
      [],
      "Markdown must never fetch remote resources automatically"
    );
    assert.deepEqual(dialogs, []);
  } finally {
    underlyingPage.off("request", onRequest);
    underlyingPage.off("dialog", onDialog);
  }
  await checkLink(
    page.locator(`[data-explanation-id="${variable.id}"] a`).first()
  );

  // Markdown never becomes editor state: independent raw drafts and revision/
  // source guards continue through the actual existing correction forms.
  const rawDrafts = [
    [
      "notes",
      block,
      "**Edited Notes**\n\n- Raw saved text\n\n`<em>not HTML</em>`",
    ],
    [
      "variables",
      variable,
      "**Edited Variables**\n\n- Independent variable text\n\n`amount < 3`",
    ],
  ];
  await page.locator("#notes-tab").click();
  await page.locator("#note-text").fill("**Unfinished plain note**");
  for (const [tab, note, raw] of rawDrafts) {
    await page.locator(`#${tab}-tab`).click();
    const entry = page.locator(`[data-explanation-id="${note.id}"]`);
    await entry.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator(`#${tab}-panel .annotation-editor`);
    assert.equal(
      await editor.getByLabel("Reviewed explanation").inputValue(),
      malicious
    );
    await editor.getByLabel("Reviewed explanation").fill(raw);
    await editor
      .getByRole("button", { name: "Keep draft and close", exact: true })
      .click();
  }
  // A real poll/revision arrives with all drafts unfinished. Retrying remains an
  // explicit review decision, not an automatic source/explanation re-review.
  const plain = await call("add_note", {
    walkthroughId: walk.id,
    stepId: "markdown",
    body: "**Plain note via public API**",
    author: "Other caller",
  });
  await page.locator("#notes-tab").click();
  await page.locator(`[data-explanation-id="${plain.id}"] strong`).waitFor();
  for (const [tab, note, raw] of rawDrafts) {
    await page.locator(`#${tab}-tab`).click();
    const entry = page.locator(`[data-explanation-id="${note.id}"]`);
    await entry.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator(`#${tab}-panel .annotation-editor`);
    assert.equal(
      await editor.getByLabel("Reviewed explanation").inputValue(),
      raw
    );
    const accept = editor.getByRole("button", {
      name: "Use my edit",
      exact: true,
    });
    await accept.click();
    await editor
      .getByRole("button", { name: "Save reviewed explanation", exact: true })
      .click();
    await entry
      .locator("strong")
      .filter({ hasText: `Edited ${tab === "notes" ? "Notes" : "Variables"}` })
      .waitFor();
    const savedWalk = await call("get_walkthrough", { id: walk.id });
    const saved = savedWalk.steps[0].notes.find(
      (saved) => saved.id === note.id
    );
    assert.equal(saved.body, raw);
    assert.equal(saved.variableName, note.variableName);
    assert.equal(saved.hash, code.hash);
    assert.deepEqual(saved.attachments, note.attachments);
    assert.equal(saved.history[0].body, body);
    assert.equal(saved.history.at(-1).body, malicious);
    await entry.getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(
      await editor.getByLabel("Reviewed explanation").inputValue(),
      raw
    );
    await editor
      .getByRole("button", { name: "Keep draft and close", exact: true })
      .click();
  }
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "**Unfinished plain note**"
  );
  await page.locator("#notes-tab").click();
  const marker = page.locator(`[data-block-note-id="${block.id}"]`).first();
  assert.equal(
    await marker.evaluate(
      (element) => globalThis.getComputedStyle(element).backgroundColor
    ),
    await page
      .locator(`[data-explanation-id="${block.id}"]`)
      .evaluate(
        (element) => globalThis.getComputedStyle(element).borderLeftColor
      )
  );
  await page
    .locator('code[data-source-line="2"] .source-attachment')
    .first()
    .click();
  assert.equal(
    await page
      .locator(`#variables [data-explanation-id="${variable.id}"]`)
      .getAttribute("aria-current"),
    "true"
  );
  const savedWalk = await call("get_walkthrough", { id: walk.id });
  assert.equal(
    savedWalk.steps[0].notes.find((note) => note.id === plain.id).attachments,
    undefined
  );
  assert.equal(
    savedWalk.steps[0].notes.find((note) => note.id === plain.id).variableName,
    undefined
  );
  if (native && reopenNative) {
    page = await reopenNative();
    await page.locator("#variables-tab.active").waitFor();
    for (const [tab, note, raw] of rawDrafts) {
      await page.locator(`#${tab}-tab`).click();
      const entry = page.locator(`[data-explanation-id="${note.id}"]`);
      await entry
        .locator("strong")
        .filter({
          hasText: `Edited ${tab === "notes" ? "Notes" : "Variables"}`,
        })
        .waitFor();
      await entry.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.locator(`#${tab}-panel .annotation-editor`);
      assert.equal(
        await editor.getByLabel("Reviewed explanation").inputValue(),
        raw
      );
      await editor
        .getByRole("button", { name: "Keep draft and close", exact: true })
        .click();
    }
    assert.deepEqual(await call("get_walkthrough", { id: walk.id }), savedWalk);
    console.log(
      "PASS native webview dispose/recreate preserves raw saved Markdown, reading tab and revision/history."
    );
  }
  await page.locator(`#paths [data-path="${original}"]`).click();
  await page
    .locator('.code-card[data-step="markdown"]')
    .waitFor({ state: "detached" });
  console.log(
    "PASS Markdown syntax/hostile HTML and URLs in actual Notes and Variables, raw editing/history, independent drafts through polling, retained attachments/colors/reveal and plain-note classification."
  );
  return {
    walkthroughId: walk.id,
    notes: rawDrafts.map(([tab, note, raw]) => ({
      tab,
      id: note.id,
      body: raw,
    })),
  };
}
