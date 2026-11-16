import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: [new URL("../ui/refresh-queue.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { createRefreshQueue } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
const latch = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
test("Explicit refresh starts only after an older automatic read drains", async () => {
  const queue = createRefreshQueue(),
    old = latch(),
    events = [];
  const a = queue(
    async () => {
      events.push("old");
      await old.promise;
      events.push("old done");
    },
    false,
    () => true
  );
  await tick();
  const b = queue(
    async () => {
      events.push("fresh");
    },
    true,
    () => true
  );
  await tick();
  assert.deepEqual(events, ["old"]);
  old.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(events, ["old", "old done", "fresh"]);
});
test("Background ticks coalesce instead of adding work behind a busy read", async () => {
  const queue = createRefreshQueue(),
    old = latch();
  let reads = 0;
  const a = queue(
    async () => {
      reads++;
      await old.promise;
    },
    false,
    () => true
  );
  await tick();
  await queue(
    async () => {
      reads++;
    },
    false,
    () => true
  );
  assert.equal(reads, 1);
  old.resolve();
  await a;
});
test("Multiple explicit callers never overlap or lose the fresh follow-up", async () => {
  const queue = createRefreshQueue();
  let live = 0,
    maximum = 0,
    reads = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      queue(
        async () => {
          maximum = Math.max(maximum, ++live);
          reads++;
          await tick();
          live--;
        },
        true,
        () => true
      )
    )
  );
  assert.equal(maximum, 1);
  assert.equal(reads, 8);
});
test("Retired queued owner cannot start, even after equal-ID/byte restoration", async () => {
  const queue = createRefreshQueue(),
    old = latch(),
    first = Symbol("A");
  let owner = first,
    started = false;
  const a = queue(
    () => old.promise,
    false,
    () => true
  );
  await tick();
  const b = queue(
    async () => {
      started = true;
    },
    true,
    () => owner === first
  );
  owner = Symbol("B");
  owner = Symbol("A");
  old.resolve();
  await Promise.all([a, b]);
  assert.equal(started, false);
});
test("Older failure belongs to its caller; queued fresh read can still succeed", async () => {
  const queue = createRefreshQueue(),
    old = latch();
  let fresh = false;
  const a = queue(
    async () => {
      await old.promise;
      throw Error("old failure");
    },
    false,
    () => true
  );
  const rejected = assert.rejects(a, /old failure/);
  await tick();
  const b = queue(
    async () => {
      fresh = true;
    },
    true,
    () => true
  );
  old.resolve();
  await Promise.all([rejected, b]);
  assert.equal(fresh, true);
});
test("Failure and synchronous throw release the permit for later reads", async () => {
  const queue = createRefreshQueue();
  await assert.rejects(
    queue(
      () => {
        throw Error("failed");
      },
      true,
      () => true
    ),
    /failed/
  );
  let ready = false;
  await queue(
    async () => {
      ready = true;
    },
    true,
    () => true
  );
  assert.equal(ready, true);
});
