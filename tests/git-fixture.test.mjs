import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { gitProject } from "./fixtures/git-project.mjs";

test("Git fixtures choose a new owned directory on a reservation-slot collision without stopping the existing listener", async (t) => {
  const prefix = path.join(os.tmpdir(), "cp-git-");
  let blocked, listener;
  for (let attempt = 0; attempt < 20; attempt++) {
    blocked = fs.mkdtempSync(prefix);
    const port =
      (crypto
        .createHash("sha256")
        .update("codepath-owner-v1\0" + fs.realpathSync(blocked))
        .digest()
        .readUInt32BE(0) %
        32768) +
      16384;
    listener = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      break;
    } catch (error) {
      fs.rmSync(blocked, { recursive: true, force: true });
      if (error.code !== "EADDRINUSE" || attempt === 19) throw error;
    }
  }
  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(blocked, { recursive: true, force: true });
  });
  const original = fs.mkdtempSync;
  let forced = false,
    f;
  fs.mkdtempSync = (candidate, ...args) => {
    if (!forced && candidate === prefix) {
      forced = true;
      return blocked;
    }
    return original(candidate, ...args);
  };
  try {
    f = await gitProject(t);
  } finally {
    fs.mkdtempSync = original;
  }
  assert.equal(forced, true);
  assert.notEqual(f.root, blocked);
  assert.equal(
    listener.listening,
    true,
    "Never take over or stop the occupied slot"
  );
  assert.equal(
    fs.existsSync(blocked),
    false,
    "Failed fixture's owned files are cleaned"
  );
  assert.ok(await f.service.call("list_git_branches"));
});
