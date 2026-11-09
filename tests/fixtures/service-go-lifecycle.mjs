import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { startProjectService } from "../../dist/service.mjs";

const base = fileURLToPath(new URL("../../", import.meta.url));

test(
  "Failed child signals do not authorize ownership release",
  { timeout: 30000 },
  () => {
    const output = childProcess.execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./service-go-signal-failure.mjs", import.meta.url)
        ),
      ],
      { encoding: "utf8", timeout: 25000 }
    );
    assert.match(output, /PASS failed child signals retain ownership/);
  }
);
for (const failPublication of [false, true]) {
  test(
    "Real Go child is reaped after " +
      (failPublication ? "publication failure" : "owner close"),
    { timeout: 120000 },
    async (t) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "codepath-go-lifetime-")
      );
      fs.cpSync(path.join(base, "examples/checkout"), root, {
        recursive: true,
      });
      fs.symlinkSync(
        path.join(base, "node_modules"),
        path.join(root, "node_modules"),
        "dir"
      );
      const spawn = childProcess.spawn,
        rename = fs.renameSync;
      let backend, service;
      childProcess.spawn = function (...args) {
        const process = spawn.apply(this, args);
        if (path.basename(String(args[0])).startsWith("checkout-go"))
          backend = process;
        return process;
      };
      syncBuiltinESMExports();
      const primary = Error("Go publication failure fixture.");
      if (failPublication) {
        fs.renameSync = function (from, to) {
          if (String(to).endsWith("/connection.json")) throw primary;
          return rename.call(this, from, to);
        };
      }
      t.after(async () => {
        childProcess.spawn = spawn;
        fs.renameSync = rename;
        syncBuiltinESMExports();
        await service?.close();
        fs.rmSync(root, { recursive: true, force: true });
      });
      const pending = startProjectService(root, {
        assetsRoot: root,
        demo: true,
        backend: "go",
      });
      if (failPublication)
        await assert.rejects(pending, (error) => error === primary);
      else {
        service = await pending;
        assert.equal((await service.request("/api/state")).paths.length, 3);
        await service.close();
      }
      assert.ok(backend, "The real Go backend must have spawned.");
      assert.ok(
        backend.exitCode !== null || backend.signalCode !== null,
        "Cleanup must await backend exit."
      );
      assert.equal(
        fs.existsSync(path.join(root, ".codepaths/connection.json")),
        false
      );
      fs.renameSync = rename;
      const next = await startProjectService(root, { assetsRoot: root });
      await next.close();
    }
  );
}
