import assert from "node:assert/strict";

// Shared real browser/native assertion. Measure the rendered description, not
// just a theme token: ancestor backgrounds and alpha affect actual contrast.
export async function assertVariableContrast(frame) {
  const selected = frame.locator('#variables .note[aria-current="true"]');
  assert.ok(
    await selected.count(),
    "A source-variable action reveals an entry"
  );
  const results = [];
  for (const entry of await selected.all()) {
    const result = await entry.locator(".markdown-body").evaluate((body) => {
      function rgba(value) {
        const n = value.match(/[\d.]+/g)?.map(Number);
        return n ? [n[0], n[1], n[2], n[3] ?? 1] : [0, 0, 0, 0];
      }
      const chain = [];
      for (let el = body; el; el = el.parentElement) chain.unshift(el);
      let background = [255, 255, 255, 1];
      for (const el of chain) {
        const color = rgba(globalThis.getComputedStyle(el).backgroundColor);
        background = [
          ...color
            .slice(0, 3)
            .map((v, i) => v * color[3] + background[i] * (1 - color[3])),
          1,
        ];
      }
      const foreground = rgba(globalThis.getComputedStyle(body).color);
      function luminance(color) {
        const n = color.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return n[0] * 0.2126 + n[1] * 0.7152 + n[2] * 0.0722;
      }
      const a = luminance(foreground),
        b = luminance(background);
      const note = body.closest(".note"),
        style = globalThis.getComputedStyle(note);
      return {
        text: body.textContent,
        foreground,
        background,
        fillAlpha: rgba(style.backgroundColor)[3],
        border: style.borderLeftStyle,
        borderWidth: parseFloat(style.borderLeftWidth),
        contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
    assert.ok(result.text?.length, "The real description is present");
    assert.ok(
      result.contrast >= 4.5,
      `Selected variable description needs4.5:1 contrast, got${result.contrast.toFixed(2)}:1`
    );
    assert.equal(
      result.fillAlpha,
      0,
      "Selection uses a quiet indicator, not a bright filled description"
    );
    assert.equal(result.border, "solid");
    assert.ok(result.borderWidth >= 2, "Selection remains visibly indicated");
    results.push(result);
  }
  return results;
}

// Explicit test palettes exercise the real native stylesheet on the real app.
// They do not claim to enumerate all user themes; actual native checks also run.
export async function assertVariableContrastPalettes(page, nativeCss) {
  const before = await page
    .locator('#variables .note[aria-current="true"] .markdown-body')
    .allTextContents();
  const style = await page.addStyleTag({ content: nativeCss });
  const original = await page.evaluate(() =>
    globalThis.document.documentElement.getAttribute("style")
  );
  try {
    for (const [foreground, background, focus] of [
      ["#bfbfbf", "#1f1f1f", "#007fd4"],
      ["#333333", "#ffffff", "#005fb8"],
      ["#ffffff", "#000000", "#f38518"],
    ]) {
      await page.evaluate(
        ([fg, bg, focus]) => {
          const root = globalThis.document.documentElement;
          root.style.setProperty("--vscode-foreground", fg);
          root.style.setProperty("--vscode-descriptionForeground", fg);
          root.style.setProperty("--vscode-editor-background", bg);
          root.style.setProperty("--vscode-focusBorder", focus);
        },
        [foreground, background, focus]
      );
      await assertVariableContrast(page);
      assert.deepEqual(
        await page
          .locator('#variables .note[aria-current="true"] .markdown-body')
          .allTextContents(),
        before
      );
    }
  } finally {
    await style.evaluate((node) => node.remove());
    await page.evaluate((style) => {
      if (style === null)
        globalThis.document.documentElement.removeAttribute("style");
      else globalThis.document.documentElement.setAttribute("style", style);
    }, original);
  }
}
