import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const [moduleUrl, root, assetsRoot, gates, role] = process.argv.slice(2);
const marker = (name) => path.join(gates, `${role}.${name}`);
const notify = (name) => fs.writeFileSync(marker(name), "ready\n");
const sleep = new Int32Array(new SharedArrayBuffer(4));
function barrier(name) {
  notify(name);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(marker(`${name}-release`))) {
    if (Date.now() >= deadline)
      throw Error(`Replay barrier expired: ${role}.${name}`);
    Atomics.wait(sleep, 0, 0, 5);
  }
}
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (this instanceof http.Server) {
    const callback = args.at(-1);
    if (typeof callback !== "function")
      throw Error("Expected HTTP listen callback.");
    args[args.length - 1] = function (...values) {
      barrier("http-ready");
      callback.apply(this, values);
    };
  } else {
    this.once("error", (error) => {
      if (error.code === "EADDRINUSE") notify("contended");
    });
  }
  return originalListen.apply(this, args);
};
const originalRename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (to === path.join(root, ".codepaths/connection.json"))
    barrier("publication-checked");
  return originalRename(from, to);
};
let handle;
try {
  const { startProjectService } = await import(moduleUrl);
  handle = await startProjectService(root, { assetsRoot, reuse: true });
  process.send({ event: "started", owned: handle.owned, url: handle.url });
} catch (error) {
  process.send({ event: "startup-error", error: error.stack });
}
process.on("message", async ({ id, operation }) => {
  try {
    if (!handle) throw Error("Worker has no service handle.");
    let result;
    if (operation === "save")
      result = await handle.call("save_walkthrough", {
        id: role,
        title: `Accepted ${role} path`,
        steps: [],
      });
    else if (operation === "close") await handle.close();
    else throw Error(`Unknown worker operation ${operation}`);
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.stack });
  }
});
