import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { startProjectService } from "../../dist/service.mjs";

const base = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-go-signal-failure-"));
const spawn = childProcess.spawn;
let backend, realKill, service;
let exitCode = 0;
try {
  fs.cpSync(path.join(base, "examples/checkout"), root, { recursive: true });
  fs.symlinkSync(
    path.join(base, "node_modules"),
    path.join(root, "node_modules"),
    "dir"
  );
  childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args);
    if (path.basename(String(args[0])).startsWith("checkout-go"))
      backend = child;
    return child;
  };
  syncBuiltinESMExports();
  service = await startProjectService(root, {
    assetsRoot: root,
    demo: true,
    backend: "go",
  });
  assert.ok(backend?.pid);
  realKill = backend.kill.bind(backend);
  let signalErrors = 0;
  backend.kill = () => {
    signalErrors++;
    backend.emit(
      "error",
      Object.assign(Error("Fixture signal denied."), { code: "EPERM" })
    );
    return false;
  };
  await assert.rejects(service.close(), /Go backend did not stop/);
  assert.equal(
    signalErrors,
    2,
    "Both termination attempts must leave exit unconfirmed."
  );
  assert.equal(backend.exitCode, null);
  assert.equal(backend.signalCode, null);
  process.kill(backend.pid, 0);
  const port =
    16384 +
    (crypto
      .createHash("sha256")
      .update("codepath-owner-v1\0" + fs.realpathSync(root))
      .digest()
      .readUInt32BE(0) %
      32768);
  const competitor = net.createServer();
  await assert.rejects(
    new Promise((resolve, reject) => {
      competitor.once("error", reject);
      competitor.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    }),
    { code: "EADDRINUSE" }
  );
  assert.ok(
    fs.existsSync(path.join(root, ".codepaths/connection.json")),
    "Unconfirmed drainage must retain the published connection."
  );
  console.log(
    "PASS failed child signals retain ownership until actual process termination."
  );
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, "close");
    (realKill ?? backend.kill.bind(backend))("SIGKILL");
    await exited;
  }
  await service?.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
