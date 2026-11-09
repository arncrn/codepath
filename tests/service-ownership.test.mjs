import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startProjectService } from "../dist/service.mjs";
import { openWorkspace } from "../dist/workspace.mjs";

const assetsRoot = fileURLToPath(new URL("../dist", import.meta.url));
const options = { assetsRoot, reuse: true };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-ownership-"));
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function submit() { return 1; }\n"
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const connectionFile = (root) => path.join(root, ".codepaths/connection.json");
const reservationPort = (root) =>
  16384 +
  (crypto
    .createHash("sha256")
    .update("codepath-owner-v1\0" + fs.realpathSync(root))
    .digest()
    .readUInt32BE(0) %
    32768);
async function save(service, title) {
  return service.call("save_walkthrough", { title, steps: [] });
}
async function retained(root, titles) {
  const service = await startProjectService(root, options);
  try {
    assert.deepEqual(
      (await service.request("/api/state")).paths.map((p) => p.title).sort(),
      titles.sort()
    );
  } finally {
    await service.close();
  }
}
function child(t, root, hold = "") {
  const proc = fork(
    new URL("./fixtures/service-owner.mjs", import.meta.url),
    [],
    {
      env: {
        ...process.env,
        PROJECT_ROOT: root,
        ASSETS_ROOT: assetsRoot,
        HOLD_LISTENER: hold,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );
  const events = new Map(),
    replies = new Map();
  let id = 0,
    logs = "";
  proc.stderr.on("data", (d) => {
    logs += d;
  });
  proc.on("message", (message) => {
    if (message.event) {
      if (!events.has(message.event)) events.set(message.event, deferred());
      events.get(message.event).resolve(message);
    } else {
      const reply = replies.get(message.id);
      if (message.error) reply.reject(Error(message.error));
      else reply.resolve(message.result);
      replies.delete(message.id);
    }
  });
  proc.on("exit", (code, signal) => {
    for (const reply of replies.values())
      reply.reject(Error(`Child exited ${code}/${signal}: ${logs}`));
    replies.clear();
  });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exit = once(proc, "exit");
      proc.kill("SIGKILL");
      await exit;
    }
  });
  return {
    proc,
    event(name) {
      if (!events.has(name)) events.set(name, deferred());
      return events.get(name).promise;
    },
    rpc(command, args) {
      return new Promise((resolve, reject) => {
        replies.set(++id, { resolve, reject });
        proc.send({ id, command, args });
      });
    },
  };
}

test(
  "Separate processes overlapping HTTP readiness preserve every acknowledged save",
  { timeout: 15000 },
  async (t) => {
    const root = fixture(t),
      first = child(t, root, "http"),
      second = child(t, root);
    await Promise.all([first.event("ready"), second.event("ready")]);
    const startingFirst = first.rpc("start");
    await first.event("held");
    const startingSecond = second.rpc("start");
    await second.event("invoked");
    await first.rpc("release");
    const [a, b] = await Promise.all([startingFirst, startingSecond]);
    await first.rpc("call", [
      "save_walkthrough",
      { title: "First accepted", steps: [] },
    ]);
    await second.rpc("call", [
      "save_walkthrough",
      { title: "Second accepted", steps: [] },
    ]);
    await second.rpc("close");
    await first.rpc("close");
    await retained(root, ["First accepted", "Second accepted"]);
    assert.equal(a.owned, true);
    assert.equal(b.owned, false);
    assert.equal(a.url, b.url);
  }
);

test(
  "Delayed failed probe rereads a removed connection before loading the latest snapshot",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t),
      owner = await startProjectService(root, options);
    t.after(() => owner.close());
    const original = globalThis.fetch,
      entered = deferred(),
      release = deferred();
    let held = false;
    globalThis.fetch = async (...args) => {
      if (!held && String(args[0]) === owner.url + "/api/state") {
        held = true;
        entered.resolve();
        await release.promise;
        throw Error("Delayed failed probe.");
      }
      return original(...args);
    };
    t.after(() => {
      globalThis.fetch = original;
      release.resolve();
    });
    const pending = startProjectService(root, options);
    await entered.promise;
    await save(owner, "Saved during probe");
    await owner.close();
    release.resolve();
    const next = await pending;
    t.after(() => next.close());
    await save(next, "Saved after handoff");
    await next.close();
    await retained(root, ["Saved during probe", "Saved after handoff"]);
  }
);

test("Same-process overlapping starts and canonical aliases share one owner", async (t) => {
  const root = fixture(t),
    alias = path.join(root, "alias");
  fs.symlinkSync(root, alias, "dir");
  const services = await Promise.all([
    startProjectService(root, options),
    startProjectService(alias, options),
  ]);
  t.after(() => Promise.all(services.map((s) => s.close())));
  assert.equal(services.filter((s) => s.owned).length, 1);
  assert.equal(services[0].url, services[1].url);
  await save(services[0], "Alias A");
  await save(services[1], "Alias B");
  await Promise.all(services.map((s) => s.close()));
  await retained(root, ["Alias A", "Alias B"]);
});

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function stop(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test(
  "A killed unpublished claimant releases its OS reservation",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t),
      first = child(t, root, "reservation");
    await first.event("ready");
    const pending = first.rpc("start");
    const rejected = assert.rejects(pending, /Child exited/);
    await first.event("held");
    assert.equal(fs.existsSync(path.join(root, ".codepaths")), false);
    const competitor = net.createServer();
    await assert.rejects(listen(competitor, reservationPort(root)), {
      code: "EADDRINUSE",
    });
    const exit = once(first.proc, "exit");
    first.proc.kill("SIGKILL");
    await exit;
    await rejected;
    const next = await startProjectService(root, options);
    await save(next, "After unpublished crash");
    await next.close();
    await retained(root, ["After unpublished crash"]);
  }
);

test(
  "A killed published owner retains its acknowledged saves across process recovery",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t),
      first = child(t, root);
    await first.event("ready");
    await first.rpc("start");
    await first.rpc("call", [
      "save_walkthrough",
      { title: "Before crash", steps: [] },
    ]);
    const exit = once(first.proc, "exit");
    first.proc.kill("SIGKILL");
    await exit;
    assert.ok(fs.existsSync(connectionFile(root)));
    const next = await startProjectService(root, options);
    await save(next, "After crash");
    await next.close();
    await retained(root, ["Before crash", "After crash"]);
  }
);

test(
  "An unrelated reservation listener blocks all workspace and maintenance writes",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t),
      blocker = net.createServer((socket) => socket.destroy());
    await listen(blocker, reservationPort(root));
    t.after(() => stop(blocker));
    await assert.rejects(
      startProjectService(root, options),
      /reservation.*busy/
    );
    assert.equal(fs.existsSync(path.join(root, ".codepaths")), false);
    await stop(blocker);
    const next = await startProjectService(root, options);
    await next.close();
  }
);

test("Strict HTTP failure and malformed workspace release the reservation", async (t) => {
  const root = fixture(t),
    blocker = net.createServer((socket) => socket.destroy());
  const port = await listen(blocker);
  await assert.rejects(
    startProjectService(root, { ...options, port, strictPort: true }),
    { code: "EADDRINUSE" }
  );
  assert.equal(fs.existsSync(connectionFile(root)), false);
  const flexible = await startProjectService(root, { ...options, port });
  assert.notEqual(Number(new URL(flexible.url).port), port);
  await flexible.close();
  await stop(blocker);
  const file = path.join(root, ".codepaths/workspace.json");
  fs.writeFileSync(file, "{");
  await assert.rejects(startProjectService(root, options), SyntaxError);
  assert.equal(fs.readFileSync(file, "utf8"), "{");
  fs.unlinkSync(file);
  const next = await startProjectService(root, options);
  await next.close();
});

test("Failed demo initialization releases ownership without publishing", async (t) => {
  const root = fixture(t);
  await assert.rejects(
    startProjectService(root, { ...options, assetsRoot: root, demo: true })
  );
  assert.equal(fs.existsSync(connectionFile(root)), false);
  const next = await startProjectService(root, options);
  await next.close();
});

test("Failed probes of unchanged live, unknown and indeterminate PIDs never authorize takeover", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".codepaths"));
  const server = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  const port = await listen(server);
  t.after(() => stop(server));
  for (const pid of [process.pid, undefined]) {
    const record = JSON.stringify({ port, token: "not-dead", pid });
    fs.writeFileSync(connectionFile(root), record);
    await assert.rejects(startProjectService(root, options), /live|unknown/);
    assert.equal(fs.readFileSync(connectionFile(root), "utf8"), record);
    assert.equal(
      fs.existsSync(path.join(root, ".codepaths/workspace.json")),
      false
    );
  }
  const original = process.kill;
  process.kill = () => {
    throw Object.assign(Error("Liveness denied"), { code: "EPERM" });
  };
  try {
    fs.writeFileSync(
      connectionFile(root),
      JSON.stringify({ port, token: "unknown", pid: process.pid })
    );
    await assert.rejects(startProjectService(root, options), /live|unknown/);
  } finally {
    process.kill = original;
  }
});

test("A changed connection after a delayed failed probe discovers the replacement owner", async (t) => {
  const root = fixture(t),
    owner = await startProjectService(root, options);
  t.after(() => owner.close());
  const realConnection = fs.readFileSync(connectionFile(root), "utf8");
  const stale = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  const stalePort = await listen(stale);
  t.after(() => stop(stale));
  fs.writeFileSync(
    connectionFile(root),
    JSON.stringify({ port: stalePort, token: "stale", pid: process.pid })
  );
  const entered = deferred(),
    release = deferred(),
    original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]) === "http://127.0.0.1:" + stalePort + "/api/state") {
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  };
  t.after(() => {
    globalThis.fetch = original;
    release.resolve();
  });
  const pending = startProjectService(root, options);
  await entered.promise;
  fs.writeFileSync(connectionFile(root), realConnection);
  release.resolve();
  const attached = await pending;
  assert.equal(attached.owned, false);
  assert.equal(attached.url, owner.url);
  await attached.close();
  assert.equal(fs.readFileSync(connectionFile(root), "utf8"), realConnection);
});

test("Foreign-token replacement survives idempotent owner close", async (t) => {
  const root = fixture(t),
    owner = await startProjectService(root, options);
  const foreign = JSON.stringify({
    port: 1,
    token: "foreign",
    pid: process.pid,
  });
  fs.writeFileSync(connectionFile(root), foreign);
  const first = owner.close(),
    second = owner.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await owner.close();
  assert.equal(fs.readFileSync(connectionFile(root), "utf8"), foreign);
  fs.unlinkSync(connectionFile(root));
  const next = await startProjectService(root, options);
  await next.close();
});

test("Dangling metadata and connection symlinks remain rejected", async (t) => {
  const root = fixture(t),
    dir = path.join(root, ".codepaths");
  fs.symlinkSync(path.join(root, "missing-directory"), dir, "dir");
  await assert.rejects(startProjectService(root, options), /symlink/);
  fs.unlinkSync(dir);
  fs.mkdirSync(dir);
  fs.symlinkSync(path.join(root, "missing-file"), connectionFile(root));
  await assert.rejects(startProjectService(root, options), /symlink/);
  assert.ok(fs.lstatSync(connectionFile(root)).isSymbolicLink());
});

test("Unexpected connection replacement aborts publication and releases both listeners", async (t) => {
  const root = fixture(t),
    original = net.Server.prototype.listen;
  const held = deferred();
  let release, httpPort;
  net.Server.prototype.listen = function (...args) {
    if (this instanceof http.Server) {
      const callback = args.pop();
      args.push(function (...values) {
        httpPort = this.address().port;
        release = () => {
          release = undefined;
          callback.apply(this, values);
        };
        held.resolve();
      });
    }
    return original.apply(this, args);
  };
  t.after(() => {
    net.Server.prototype.listen = original;
    release?.();
  });
  const pending = startProjectService(root, options);
  await held.promise;
  const replacement = JSON.stringify({
    port: 1,
    token: "replacement",
    pid: process.pid,
  });
  fs.writeFileSync(connectionFile(root), replacement);
  release();
  await assert.rejects(pending, /Connection changed/);
  net.Server.prototype.listen = original;
  assert.equal(fs.readFileSync(connectionFile(root), "utf8"), replacement);
  assert.equal(
    fs
      .readdirSync(path.join(root, ".codepaths"))
      .some((f) => f.endsWith(".tmp")),
    false
  );
  const reservation = net.createServer(),
    publicListener = net.createServer();
  await listen(reservation, reservationPort(root));
  await listen(publicListener, httpPort);
  await Promise.all([stop(reservation), stop(publicListener)]);
});

test("Publication write failure preserves its exception and removes its exclusive temporary file", async (t) => {
  const root = fixture(t),
    original = fs.writeFileSync;
  const primary = Error("Publication disk failure");
  fs.writeFileSync = function (file, ...args) {
    if (typeof file === "number") {
      original.call(this, file, "partial");
      throw primary;
    }
    return original.call(this, file, ...args);
  };
  try {
    await assert.rejects(
      startProjectService(root, options),
      (error) => error === primary
    );
  } finally {
    fs.writeFileSync = original;
  }
  assert.equal(fs.existsSync(connectionFile(root)), false);
  assert.equal(
    fs
      .readdirSync(path.join(root, ".codepaths"))
      .some((f) => f.endsWith(".tmp")),
    false
  );
  const next = await startProjectService(root, options);
  await next.close();
});

test(
  "Drain failure retains the reservation until process death",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t);
    const proc = fork(
      new URL("./fixtures/service-drain-failure.mjs", import.meta.url),
      [],
      {
        env: { ...process.env, PROJECT_ROOT: root, ASSETS_ROOT: assetsRoot },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      }
    );
    t.after(async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exit = once(proc, "exit");
        proc.kill("SIGKILL");
        await exit;
      }
    });
    const [message] = await once(proc, "message");
    assert.match(message.error, /Drain failure fixture/);
    assert.ok(fs.existsSync(connectionFile(root)));
    const blocked = net.createServer();
    await assert.rejects(listen(blocked, reservationPort(root)), {
      code: "EADDRINUSE",
    });
    const exit = once(proc, "exit");
    proc.kill("SIGKILL");
    await exit;
    const next = await startProjectService(root, options);
    await next.close();
  }
);

for (const route of ["/api/call", "/api/demo/capture"]) {
  test("Closing rejects a delayed POST body at " + route, async (t) => {
    const root = fixture(t);
    const demo = route === "/api/demo/capture";
    if (demo) {
      fs.cpSync(path.join(assetsRoot, "../examples/checkout"), root, {
        recursive: true,
        filter: (file) => !file.split(path.sep).includes(".codepaths"),
      });
      fs.symlinkSync(
        path.join(assetsRoot, "../node_modules"),
        path.join(root, "node_modules"),
        "dir"
      );
    }
    const service = await startProjectService(root, {
      ...options,
      assetsRoot: demo ? root : assetsRoot,
      demo,
    });
    t.after(() => service.close());
    const initial = await service.request("/api/state");
    const { token } = JSON.parse(fs.readFileSync(connectionFile(root), "utf8"));
    const entered = deferred(),
      original = http.Server.prototype.emit;
    http.Server.prototype.emit = function (event, ...args) {
      const result = original.call(this, event, ...args);
      if (event === "request" && args[0].url === route) entered.resolve();
      return result;
    };
    t.after(() => {
      http.Server.prototype.emit = original;
    });
    const walkthrough = demo
      ? await service.call("get_walkthrough", { id: "checkout-node" })
      : undefined;
    const payload = JSON.stringify(
      demo
        ? {
            walkthroughId: walkthrough.id,
            label: "Late capture",
            events: [{ stepId: walkthrough.steps[0].id, output: "late" }],
          }
        : {
            name: "save_walkthrough",
            arguments: { title: "Late write", steps: [] },
          }
    );
    const request = http.request(service.url + route, {
      method: "POST",
      headers: {
        "X-Codepath-Token": token,
        "Content-Length": Buffer.byteLength(payload),
      },
    });
    let acknowledged = false;
    const ended = new Promise((resolve) => {
      request.on("error", () => resolve());
      request.on("response", (response) => {
        acknowledged = response.statusCode === 200;
        response.resume();
        response.on("end", resolve);
      });
    });
    request.write(payload.slice(0, -1));
    await entered.promise;
    const closing = service.close();
    request.end(payload.slice(-1));
    await Promise.all([closing, ended]);
    assert.equal(acknowledged, false);
    http.Server.prototype.emit = original;
    const successor = await startProjectService(root, options);
    const after = await successor.request("/api/state");
    assert.deepEqual(after.paths, initial.paths);
    assert.deepEqual(after.runs, initial.runs);
    await save(successor, "After drain");
    await successor.close();
    await retained(root, [...initial.paths.map((p) => p.title), "After drain"]);
  });
}

test(
  "Published legacy owner is reused; maintenance, notes and runs survive a blocked handoff",
  { timeout: 15000 },
  async (t) => {
    const root = fixture(t),
      workspace = openWorkspace(root);
    const walk = workspace.invoke("save_walkthrough", {
      title: "Retained path",
      steps: [
        {
          id: "submit",
          title: "Submit",
          source: { file: "flow.ts", symbol: "submit" },
        },
      ],
    });
    const note = workspace.invoke("add_note", {
      walkthroughId: walk.id,
      stepId: "submit",
      body: "Original note",
      author: "Test",
    });
    const run = workspace.invoke("record_run", {
      walkthroughId: walk.id,
      label: "Retained run",
      mode: "example",
      origin: "Test",
      events: [{ stepId: "submit", output: 1 }],
    });
    const token = crypto.randomBytes(24).toString("hex");
    const legacy = http.createServer(async (req, res) => {
      if (req.headers["x-codepath-token"] !== token) {
        res.writeHead(401);
        res.end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const data =
        req.method === "POST"
          ? (() => {
              const call = JSON.parse(body);
              return workspace.invoke(call.name, call.arguments);
            })()
          : workspace.overview();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    });
    const port = await listen(legacy);
    t.after(() => stop(legacy));
    const connection = JSON.stringify({
      port,
      token,
      root: fs.realpathSync(root),
      pid: process.pid,
    });
    fs.writeFileSync(connectionFile(root), connection);
    const queue = path.join(root, ".codepaths/pending-note-updates.json");
    fs.writeFileSync(
      queue,
      JSON.stringify({
        id: "handoff",
        updates: [
          {
            walkthroughId: walk.id,
            stepId: "submit",
            noteId: note.id,
            oldBody: note.body,
            oldHash: note.hash,
            newBody: "Reviewed note",
            sourceHash: note.hash,
            author: "Reviewer",
          },
        ],
      })
    );
    const attached = await startProjectService(root, options);
    assert.equal(attached.owned, false);
    assert.equal(attached.url, "http://127.0.0.1:" + port);
    await assert.rejects(
      startProjectService(root, { ...options, reuse: false }),
      /already open/
    );
    assert.equal(
      (await attached.call("get_walkthrough", { id: walk.id })).steps[0]
        .notes[0].body,
      "Original note"
    );
    await save(attached, "Legacy accepted");
    await attached.close();
    assert.equal(fs.readFileSync(connectionFile(root), "utf8"), connection);
    assert.ok(fs.existsSync(queue));
    await stop(legacy);
    fs.unlinkSync(connectionFile(root));
    const bytes = fs.readFileSync(
      path.join(root, ".codepaths/workspace.json"),
      "utf8"
    );
    const blocker = net.createServer((socket) => socket.destroy());
    await listen(blocker, reservationPort(root));
    t.after(() => stop(blocker));
    await assert.rejects(
      startProjectService(root, options),
      /reservation.*busy/
    );
    assert.equal(
      fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
      bytes
    );
    assert.ok(fs.existsSync(queue));
    await stop(blocker);
    const services = await Promise.all([
      startProjectService(root, options),
      startProjectService(root, options),
    ]);
    t.after(() => Promise.all(services.map((s) => s.close())));
    const after = await services[0].call("get_walkthrough", { id: walk.id });
    assert.equal(after.steps[0].notes[0].id, note.id);
    assert.equal(after.steps[0].notes[0].body, "Reviewed note");
    assert.equal(after.steps[0].notes[0].history.length, 1);
    assert.equal(after.steps[0].notes[0].history[0].body, "Original note");
    assert.equal((await services[1].request("/api/state")).runs[0].id, run.id);
    assert.equal(fs.existsSync(queue), false);
    for (let i = 0; i < services.length; i++)
      await save(services[i], "New accepted " + i);
    await Promise.all(services.map((s) => s.close()));
    await retained(root, [
      "Retained path",
      "Legacy accepted",
      "New accepted 0",
      "New accepted 1",
    ]);
    const restarted = await startProjectService(root, options);
    t.after(() => restarted.close());
    const again = await restarted.call("get_walkthrough", { id: walk.id });
    assert.equal(again.steps[0].notes[0].history.length, 1);
    assert.equal((await restarted.request("/api/state")).runs[0].id, run.id);
  }
);

test(
  "A paused unpublished owner never times out into takeover",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t),
      first = child(t, root, "reservation");
    await first.event("ready");
    const pending = first.rpc("start");
    await first.event("held");
    await assert.rejects(
      startProjectService(root, options),
      /reservation.*busy/
    );
    assert.equal(fs.existsSync(path.join(root, ".codepaths")), false);
    await first.rpc("release");
    assert.equal((await pending).owned, true);
    await first.rpc("close");
  }
);

test("A body parsed just as close starts cannot mutate after its await", async (t) => {
  const root = fixture(t),
    service = await startProjectService(root, options);
  t.after(() => service.close());
  const original = JSON.parse,
    triggered = deferred();
  let closing;
  JSON.parse = function (text, ...args) {
    const parsed = original.call(this, text, ...args);
    if (parsed?.arguments?.title === "Post-await write") {
      JSON.parse = original;
      closing = service.close();
      triggered.resolve();
    }
    return parsed;
  };
  t.after(() => {
    JSON.parse = original;
  });
  const request = save(service, "Post-await write");
  const rejected = assert.rejects(request);
  await triggered.promise;
  await closing;
  await rejected;
  JSON.parse = original;
  await retained(root, []);
});

test(
  "Two roots with a reservation hash collision fail closed instead of choosing another port",
  { timeout: 10000 },
  async (t) => {
    const root = fs.realpathSync(fixture(t)),
      ports = new Map();
    let pair;
    for (let i = 0; i < 10000 && !pair; i++) {
      const candidate = path.join(root, "collision-" + i);
      const port =
        16384 +
        (crypto
          .createHash("sha256")
          .update("codepath-owner-v1\0" + candidate)
          .digest()
          .readUInt32BE(0) %
          32768);
      if (ports.has(port)) pair = [ports.get(port), candidate];
      else ports.set(port, candidate);
    }
    assert.ok(
      pair,
      "The deterministic candidate set must contain a collision."
    );
    for (const candidate of pair) fs.mkdirSync(candidate);
    assert.equal(reservationPort(pair[0]), reservationPort(pair[1]));
    const owner = await startProjectService(pair[0], options);
    t.after(() => owner.close());
    await assert.rejects(
      startProjectService(pair[1], options),
      /reservation.*busy/
    );
    assert.equal(fs.existsSync(path.join(pair[1], ".codepaths")), false);
    await save(owner, "Collision owner save");
    await owner.close();
    await retained(pair[0], ["Collision owner save"]);
    const next = await startProjectService(pair[1], options);
    await next.close();
  }
);

test(
  "An actual timed-out probe cannot revoke an unchanged live PID",
  { timeout: 5000 },
  async (t) => {
    const root = fixture(t),
      server = http.createServer(() => {});
    const port = await listen(server);
    t.after(() => {
      server.closeAllConnections();
      return stop(server);
    });
    fs.mkdirSync(path.join(root, ".codepaths"));
    const record = JSON.stringify({
      port,
      token: "held-probe",
      pid: process.pid,
    });
    fs.writeFileSync(connectionFile(root), record);
    await assert.rejects(startProjectService(root, options), /live|unknown/);
    assert.equal(fs.readFileSync(connectionFile(root), "utf8"), record);
    assert.equal(
      fs.existsSync(path.join(root, ".codepaths/workspace.json")),
      false
    );
  }
);

test(
  "Close retains ownership until a socket-independent async body continuation drains",
  { timeout: 10000 },
  async (t) => {
    const root = fixture(t),
      service = await startProjectService(root, options);
    const entered = deferred(),
      release = deferred(),
      httpClosed = deferred();
    const iterate = http.IncomingMessage.prototype[Symbol.asyncIterator];
    const originalClose = http.Server.prototype.close;
    http.IncomingMessage.prototype[Symbol.asyncIterator] = async function* () {
      for await (const chunk of iterate.call(this)) yield chunk;
      if (this.url === "/api/call") {
        entered.resolve();
        await release.promise;
      }
    };
    http.Server.prototype.close = function (callback) {
      return originalClose.call(this, (error) => {
        callback(error);
        httpClosed.resolve();
      });
    };
    t.after(async () => {
      release.resolve();
      http.IncomingMessage.prototype[Symbol.asyncIterator] = iterate;
      http.Server.prototype.close = originalClose;
      await service.close();
    });
    const request = save(service, "Held continuation write");
    const rejected = assert.rejects(request);
    await entered.promise;
    let finished = false;
    const closing = service.close().then(() => {
      finished = true;
    });
    await httpClosed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    const blocked = net.createServer();
    await assert.rejects(listen(blocked, reservationPort(root)), {
      code: "EADDRINUSE",
    });
    assert.ok(fs.existsSync(connectionFile(root)));
    release.resolve();
    await Promise.all([closing, rejected]);
    http.IncomingMessage.prototype[Symbol.asyncIterator] = iterate;
    http.Server.prototype.close = originalClose;
    await retained(root, []);
  }
);
