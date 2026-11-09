import fs from "node:fs/promises";
import { build } from "esbuild";

await fs.mkdir("dist", { recursive: true });
// Keep runtime import paths stable (.mjs), while authoring every application
// module in TypeScript. Tests exercise these emitted modules, not a TS loader.
await build({
  entryPoints: [
    "indexer.mts",
    "source-parser.mts",
    "source-project.mts",
    "references.mts",
    "source-usage.mts",
    "workspace.mts",
    "annotations.mts",
    "service.mts",
    "service-ownership.mts",
    "seed.mts",
    "tools.mts",
    "client.mts",
    "agent.mts",
    "server.mts",
    "types.mts",
    "vscode/bridge.mts",
    "vscode/definition.mts",
  ],
  outdir: "dist",
  outbase: ".",
  outExtension: { ".js": ".mjs" },
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
await build({
  entryPoints: ["vscode/extension.mts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode", "esbuild"],
  logLevel: "info",
});
await build({
  entryPoints: ["ui.tsx"],
  outfile: "dist/ui.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
for (const file of ["ui.html", "style.css", "demo.html"]) {
  await fs.copyFile(file, "dist/" + file);
}
await fs.copyFile("vscode/vscode.css", "dist/vscode.css");
// The unchanged JavaScript backend is a language-support demo, not tool code.
await fs.cp("examples/checkout/api", "dist/examples/checkout/api", {
  recursive: true,
});
