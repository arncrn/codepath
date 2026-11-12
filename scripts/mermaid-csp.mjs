import fs from "node:fs/promises";

// Mermaid assumes inline diagram CSS is permitted. Our diagrams use only a
// fixed grammar and external local CSS, and never retain Mermaid's CSS. Keep
// that policy during its temporary measurement/render too. Fail closed on
// dependency drift rather than silently shipping an ineffective adaptation.
export const mermaidCsp = {
  name: "mermaid-passive-csp",
  setup(build) {
    const adapted = new Set();
    build.onEnd(() => {
      if (adapted.size !== 3)
        throw Error(
          "Mermaid passive-SVG adaptation needs review: expected core, SVG text and D3 modules."
        );
    });
    build.onLoad(
      {
        filter:
          /\/(mermaid\.core|d3-selection)\.mjs$|\/mermaid\/dist\/chunks\/mermaid\.core\/.*\.mjs$/,
      },
      async ({ path }) => {
        let contents = await fs.readFile(path, "utf8");
        const replace = (before, after) => {
          if (contents.split(before).length !== 2)
            throw Error("Mermaid CSP adaptation needs review: " + path);
          contents = contents.replace(before, after);
        };
        if (path.includes("/chunks/")) {
          if (contents.includes("function decodeHTMLEntities(text) {")) {
            // Mermaid's SVG-only label decoder handles named amp/lt/gt, but not
            // its documented numeric DSL escapes. Decode these as text before
            // measurement, never as HTML; one pass also preserves literal entities.
            replace(
              "const regex = /&(amp|lt|gt);/g;",
              "const regex = /&(amp|lt|gt|#\\d+);/g;"
            );
            replace(
              "switch (entity) {",
              'if (entity.startsWith("#")) { const point = Number(entity.slice(1)); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\\ufffd"; }\n    switch (entity) {'
            );
            replace(
              "const svgLabel = createFormattedText(",
              "if (!markdown) for (const line of structuredText) for (const word of line) word.content = decodeHTMLEntities(word.content);\n    const svgLabel = createFormattedText("
            );
            replace(
              "innerTspan.text(decodeHTMLEntities(word.content));",
              "innerTspan.text(word.content);"
            );
            replace(
              'innerTspan.text(" " + decodeHTMLEntities(word.content));',
              'innerTspan.text(" " + word.content);'
            );
            adapted.add("text");
          }
        } else if (path.includes("/mermaid/")) {
          replace(
            "svg.insertBefore(style1, firstChild);",
            "/* Static local CSS replaces generated diagram CSS. */"
          );
          replace(
            "let code2 = root.select(enclosingDivID_selector).node().innerHTML;",
            'root.select(enclosingDivID_selector).selectAll("[style]").attr("style", null);\n    let code2 = root.select(enclosingDivID_selector).node().innerHTML;'
          );
          adapted.add("core");
        } else if (path.includes("/d3-selection/")) {
          // CSSOM writes are supported by a strict style-src; raw style attribute
          // writes are not. Only this renderer's bundled D3 adapter is changed,
          // never DOM prototypes, application code or host policy.
          replace(
            "this.setAttribute(name, value);",
            'if (name === "style") this.style.cssText = value; else this.setAttribute(name, value);'
          );
          replace(
            "else this.setAttribute(name, v);",
            'else if (name === "style") this.style.cssText = v; else this.setAttribute(name, v);'
          );
          adapted.add("d3");
        }
        return { contents, loader: "js" };
      }
    );
  },
};
