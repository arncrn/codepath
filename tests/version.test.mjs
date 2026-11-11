import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("Package, lockfile and actual MCP initialization advertise the same release", async () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  const lock = JSON.parse(
    fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
  );
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/agent.mjs", import.meta.url))],
    { timeout: 5000 }
  );
  let output = "",
    errors = "";
  child.stdout.setEncoding("utf8").on("data", (data) => {
    output += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    errors += data;
  });
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }) + "\n"
  );
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null, errors);
  assert.equal(code, 0, errors);
  assert.equal(
    JSON.parse(output.trim()).result.serverInfo.version,
    manifest.version
  );
});
