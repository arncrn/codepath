import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { transform } from "esbuild";
import { sha256 } from "./tlc.mjs";

async function bounded(promise, label, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`Replay timed out: ${label}`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(`Replay timed out: ${label}`);
    await delay(5);
  }
}
async function compile(projectRoot, sources, scratch) {
  const files = new Set(
    Object.keys(sources).map((file) => file.replace(/\.mts$/, ".mjs"))
  );
  const compiled = {};
  for (const [name, text] of Object.entries(sources)) {
    const output = await transform(text, {
      loader: "ts",
      format: "esm",
      target: "node22",
    });
    const code = output.code.replace(/from "(\.\/[^"\n]+)"/g, (_, relative) => {
      const local = relative.slice(2);
      return `from ${JSON.stringify(
        pathToFileURL(
          path.resolve(
            files.has(local) ? scratch : path.join(projectRoot, "dist"),
            local
          )
        ).href
      )}`;
    });
    const file = name.replace(/\.mts$/, ".mjs");
    fs.writeFileSync(path.join(scratch, file), code);
    compiled[name] = {
      sourceSha256: sha256(text),
      compiledSha256: sha256(code),
    };
  }
  assert.ok(
    fs
      .readFileSync(path.join(scratch, "service.mjs"), "utf8")
      .includes(
        pathToFileURL(path.join(scratch, "service-ownership.mjs")).href
      ),
    "The scratch service must import the scratch helper, including mutations."
  );
  return compiled;
}
function worker(moduleUrl, root, assetsRoot, gates, role) {
  const child = fork(
    new URL("./replay-worker.mjs", import.meta.url),
    [moduleUrl, root, assetsRoot, gates, role],
    { silent: true }
  );
  const started = deferred(),
    exited = deferred();
  const requests = new Map();
  let nextId = 0,
    output = "",
    startResult;
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  child.on("message", (message) => {
    if (message.event) {
      startResult = message;
      started.resolve(message);
    } else {
      const response = requests.get(message.id);
      assert.ok(response, "Unexpected replay worker reply.");
      requests.delete(message.id);
      response.resolve(message);
    }
  });
  child.on("error", (error) => {
    startResult ??= { error: error.stack };
    started.resolve(startResult);
  });
  child.on("exit", (code, signal) => {
    startResult ??= {
      error: `Worker exited before startup: ${code} ${signal}\n${output}`,
    };
    started.resolve(startResult);
    exited.resolve({ code, signal });
  });
  return {
    child,
    get result() {
      return startResult;
    },
    async start() {
      const result = await bounded(started.promise, `${role} startup`);
      if (result.error) throw Error(result.error);
      return result;
    },
    async call(operation) {
      const id = ++nextId,
        response = deferred();
      requests.set(id, response);
      child.send({ id, operation });
      const result = await bounded(response.promise, `${role} ${operation}`);
      if (result.error) throw Error(result.error);
      return result.result;
    },
    async finish() {
      if (child.connected) child.disconnect();
      let result;
      try {
        result = await bounded(exited.promise, `${role} exit`);
      } catch (error) {
        child.kill("SIGTERM");
        await bounded(exited.promise, `${role} owned replay child cleanup`);
        throw error;
      }
      assert.equal(result.code, 0, `Replay worker failed: ${output}`);
      assert.equal(result.signal, null);
    },
  };
}
function storedPaths(root) {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8")
  ).paths.map((saved) => saved.id);
}
async function overlap(projectRoot, moduleUrl, root, scratch) {
  const gates = path.join(scratch, "gates");
  fs.mkdirSync(gates);
  const marker = (role, name) => path.join(gates, `${role}.${name}`);
  const ready = (role, name) => fs.existsSync(marker(role, name));
  const release = (role, name) =>
    fs.writeFileSync(marker(role, `${name}-release`), "go\n");
  const workers = [];
  const sequence = [],
    errors = [];
  let result;
  try {
    const first = worker(
      moduleUrl,
      root,
      path.join(projectRoot, "dist"),
      gates,
      "first"
    );
    workers.push(first);
    await waitFor(
      () => ready("first", "http-ready") || first.result,
      "first actual HTTP callback"
    );
    assert.ok(ready("first", "http-ready"), JSON.stringify(first.result));
    sequence.push(
      "A holds its real HTTP listen callback before readiness continuation and publication."
    );
    const second = worker(
      moduleUrl,
      root,
      path.join(projectRoot, "dist"),
      gates,
      "second"
    );
    workers.push(second);
    await waitFor(
      () =>
        ready("second", "contended") ||
        ready("second", "http-ready") ||
        second.result,
      "B reservation contention or actual HTTP callback"
    );
    assert.ok(!second.result, JSON.stringify(second.result));
    const twoListeners = ready("second", "http-ready");
    sequence.push(
      twoListeners
        ? "B also reaches a real HTTP listener before A publishes."
        : "B's real exclusive reservation reports EADDRINUSE before A publishes."
    );
    release("first", "http-ready");
    if (twoListeners) release("second", "http-ready");
    await waitFor(
      () => ready("first", "publication-checked"),
      "A final publication identity check"
    );
    if (twoListeners)
      await waitFor(
        () => ready("second", "publication-checked"),
        "B final publication identity check"
      );
    sequence.push(
      twoListeners
        ? "Both processes pass their final identity checks before either atomic connection rename."
        : "Only A can reach the final publication identity check."
    );
    release("first", "publication-checked");
    const a = await first.start();
    const firstPath = await first.call("save");
    sequence.push(
      "A publishes and acknowledges its save through actual HTTP and workspace persistence."
    );
    if (twoListeners) release("second", "publication-checked");
    const b = await second.start();
    const secondPath = await second.call("save");
    const paths = storedPaths(root);
    const published = JSON.parse(
      fs.readFileSync(path.join(root, ".codepaths/connection.json"), "utf8")
    );
    const publishedUrl = "http://127.0.0.1:" + published.port;
    sequence.push(
      b.owned
        ? "B publishes independently and acknowledges a save from its own snapshot."
        : "B probes A, attaches at the same published URL, and acknowledges its save through A."
    );
    const oneOwner =
      Number(a.owned) + Number(b.owned) <= 1 &&
      a.url === b.url &&
      b.url === publishedUrl;
    const savesKept = [firstPath.id, secondPath.id].every((id) =>
      paths.includes(id)
    );
    result = {
      scenario: "overlapping-starts",
      sequence,
      first: a,
      second: b,
      publishedUrl,
      acceptedIds: [firstPath.id, secondPath.id],
      diskPaths: paths,
      invariants: {
        AtMostOneLiveOwner: oneOwner,
        AcceptedPathsPreserved: savesKept,
      },
    };
  } catch (error) {
    errors.push(error);
  } finally {
    for (const role of ["first", "second"])
      for (const gate of ["http-ready", "publication-checked"])
        release(role, gate);
    for (const running of workers) {
      try {
        const started = await running.start();
        if (started.event === "started") await running.call("close");
      } catch (error) {
        errors.push(error);
      }
      try {
        await running.finish();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Overlap replay failed.");
  result.afterCloseDiskPaths = storedPaths(root);
  result.invariants.AcceptedPathsPreserved &&= result.acceptedIds.every((id) =>
    result.afterCloseDiskPaths.includes(id)
  );
  return result;
}
async function failedProbe(start, root, options) {
  const first = await start(root, options),
    paused = deferred(),
    resume = deferred();
  const originalFetch = globalThis.fetch;
  const sequence = [],
    handles = [first],
    errors = [];
  let secondOutcome,
    result,
    intercepted = false;
  globalThis.fetch = async function (input, init) {
    if (!intercepted && String(input) === first.url + "/api/state") {
      intercepted = true;
      paused.resolve();
      await resume.promise;
      return originalFetch(input, init);
    }
    return originalFetch(input, init);
  };
  try {
    secondOutcome = start(root, options).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await bounded(paused.promise, "B old-owner probe entry");
    sequence.push(
      "B starts and pauses immediately before its real authenticated probe of A."
    );
    const a = await first.call("save_walkthrough", {
      id: "first",
      title: "First accepted",
      steps: [],
    });
    sequence.push(
      "A acknowledges a new-path save while B's old-owner probe is pending."
    );
    const pid = process.pid;
    await first.close();
    process.kill(pid, 0);
    sequence.push(
      "A drains, removes its connection, and releases its reservation in a still-live PID."
    );
    resume.resolve();
    const outcome = await secondOutcome;
    if (outcome.error) throw outcome.error;
    const second = outcome.value;
    handles.push(second);
    const b = await second.call("save_walkthrough", {
      id: "second",
      title: "Second accepted",
      steps: [],
    });
    const paths = storedPaths(root);
    sequence.push(
      "B's actual probe fails, discovery rereads the removed record, and B claims, loads, publishes, and saves."
    );
    result = {
      scenario: "failed-probe-freshness",
      sequence,
      pidStillAlive: process.pid === pid,
      acceptedIds: [a.id, b.id],
      diskPaths: paths,
      invariants: {
        AcceptedPathsPreserved: [a.id, b.id].every((id) => paths.includes(id)),
      },
    };
  } catch (error) {
    errors.push(error);
  } finally {
    resume.resolve();
    globalThis.fetch = originalFetch;
    if (secondOutcome && !handles[1]) {
      const outcome = await secondOutcome;
      if (outcome.value) handles.push(outcome.value);
      if (outcome.error && !errors.includes(outcome.error))
        errors.push(outcome.error);
    }
    for (const handle of handles) {
      try {
        await handle.close();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Failed-probe replay failed.");
  result.afterCloseDiskPaths = storedPaths(root);
  result.invariants.AcceptedPathsPreserved &&= result.acceptedIds.every((id) =>
    result.afterCloseDiskPaths.includes(id)
  );
  return result;
}
async function foreignRecord(start, root, options) {
  const handle = await start(root, options),
    errors = [];
  const file = path.join(root, ".codepaths/connection.json");
  let result;
  try {
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    const foreign =
      JSON.stringify({ ...original, token: "bounded-external-foreign-token" }) +
      "\n";
    fs.writeFileSync(file + ".external", foreign);
    fs.renameSync(file + ".external", file);
    await handle.close();
    await handle.close();
    result = {
      scenario: "external-foreign-record",
      sequence: [
        "A publishes a real service connection.",
        "The test environment atomically replaces the record with a different token before close.",
        "A closes and closes again. The foreign record must remain byte-for-byte unchanged.",
      ],
      invariants: {
        ForeignConnectionPreserved:
          fs.existsSync(file) && fs.readFileSync(file, "utf8") === foreign,
      },
    };
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Foreign-record replay failed.");
  return result;
}
async function closePending(start, root, options) {
  const handle = await start(root, options);
  const token = JSON.parse(
    fs.readFileSync(path.join(root, ".codepaths/connection.json"), "utf8")
  ).token;
  const body = JSON.stringify({
    name: "save_walkthrough",
    arguments: {
      id: "pending",
      title: "Must not be accepted after close",
      steps: [],
    },
  });
  const observed = deferred();
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    const returned = originalEmit.call(this, event, ...args);
    if (event === "request" && args[0].url === "/api/call") observed.resolve();
    return returned;
  };
  const request = http.request(handle.url + "/api/call", {
    method: "POST",
    headers: {
      "X-Codepath-Token": token,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  });
  const response = new Promise((resolve, reject) => {
    request.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve({ status: res.statusCode }));
      res.once("error", reject);
    });
    request.once("error", (error) => {
      if (["ECONNRESET", "EPIPE"].includes(error.code))
        resolve({ disconnected: error.code });
      else reject(error);
    });
  });
  const responseOutcome = response.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  try {
    request.write(body.slice(0, -1));
    await bounded(observed.promise, "incomplete actual POST body");
    await handle.close();
    request.end(body.slice(-1));
    const settled = await bounded(responseOutcome, "pending POST close result");
    if (settled.error) throw settled.error;
    const outcome = settled.value;
    assert.ok(
      outcome.disconnected || outcome.status >= 400,
      "An incomplete POST must not receive a successful acknowledgement after close."
    );
    const file = path.join(root, ".codepaths/workspace.json");
    assert.ok(!fs.existsSync(file) || !storedPaths(root).includes("pending"));
    return { scenario: "close-pending-body", passed: true, outcome };
  } finally {
    http.Server.prototype.emit = originalEmit;
    request.destroy();
    await handle.close();
  }
}

export async function replayServiceOwnership(projectRoot, sources) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cp-owner-proof-"));
  try {
    const compiled = await compile(projectRoot, sources, scratch);
    const moduleUrl = pathToFileURL(path.join(scratch, "service.mjs")).href;
    const { startProjectService: start } = await import(moduleUrl);
    const options = { assetsRoot: path.join(projectRoot, "dist"), reuse: true };
    const root = (name) => {
      const dir = path.join(scratch, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "flow.ts"), "export const value = 1;\n");
      return fs.realpathSync(dir);
    };
    const scenarios = [
      await overlap(projectRoot, moduleUrl, root("overlap"), scratch),
      await failedProbe(start, root("freshness"), options),
      await foreignRecord(start, root("foreign"), options),
      await closePending(start, root("close"), options),
    ];
    return { compiled, scenarios };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
