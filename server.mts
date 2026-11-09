import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProjectService } from "./service.mjs";
const base = path.dirname(fileURLToPath(import.meta.url)),
  appRoot = path.resolve(base, "..");
const args = process.argv.slice(2),
  option = (n: string, d: string) =>
    args.includes(n) ? args[args.indexOf(n) + 1] : d;
if (args.includes("--help")) {
  console.log(
    "npm start [-- /absolute/project]\nnpm run demo:go\nOptions: --root PATH --port NUMBER --backend node|go"
  );
  process.exit(0);
}
const positional = args.find(
  (a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))
);
const root = path.resolve(
  option("--root", positional ?? path.join(appRoot, "examples/checkout"))
);
const service = await startProjectService(root, {
  assetsRoot: base,
  port: Number(option("--port", "4317")),
  strictPort: args.includes("--port"),
  demo: root === path.join(appRoot, "examples/checkout"),
  backend: option("--backend", "node") as "node" | "go",
});
console.log(
  "\nCodepath prototype\nOpen " +
    service.url +
    "\nProject: " +
    service.root +
    "\nStop with Ctrl+C.\n"
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await service.close();
    process.exit(0);
  });
