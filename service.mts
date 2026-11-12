import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { openWorkspace } from "./workspace.mjs";
import { createGitComparison } from "./git-comparison.mjs";
import {
  parseComparisonAuthoring,
  parseWalkthroughComparisonNote,
} from "./comparison-walkthroughs.mjs";
import { claimProjectService } from "./service-ownership.mjs";
import { viewedMarkRequest } from "./git-viewed.mjs";
import { parseFile, sourceExtensions } from "./source-parser.mjs";
import { functionContext } from "./source-functions.mjs";
import { seed } from "./seed.mjs";
import { handleOrder } from "./examples/checkout/api/router.mjs";

import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import type {
  ProjectService,
  Overview,
  ToolName,
  ToolArgs,
  ToolResults,
  RunEvent,
} from "./types.mjs";
import { errorMessage } from "./types.mjs";
interface ServiceOptions {
  assetsRoot: string;
  toolRoot?: string;
  port?: number;
  strictPort?: boolean;
  reuse?: boolean;
  demo?: boolean;
  backend?: "node" | "go";
}
interface Connection {
  port: number;
  token: string;
}

// The browser CLI and extension own the same service. Only its owner may stop it.
export async function startProjectService(
  root: string,
  {
    assetsRoot,
    toolRoot = assetsRoot,
    port = 0,
    strictPort = false,
    reuse = false,
    demo = false,
    backend = "node",
  }: ServiceOptions
): Promise<ProjectService> {
  root = fs.realpathSync(root);
  if (!["node", "go"].includes(backend))
    throw Error("Backend must be node or go.");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("Invalid port.");
  const remote = (
    c: Connection,
    owned: boolean,
    close: () => Promise<void>
  ): ProjectService => {
    const url = "http://127.0.0.1:" + c.port;
    function request(route: "/api/state"): Promise<Overview>;
    function request(route: string, body?: unknown): Promise<unknown>;
    async function request(route: string, body?: unknown): Promise<unknown> {
      if (!["/api/state", "/api/call"].includes(route))
        throw Error("Unsupported service request.");
      const r = await fetch(url + route, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Codepath-Token": c.token,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      const data: unknown = await r.json();
      if (!r.ok)
        throw Error((data as { error?: string }).error || "Request failed.");
      return data;
    }
    return {
      root,
      url,
      owned,
      close,
      request,
      call<N extends ToolName>(name: N, args: ToolArgs[N]) {
        return request("/api/call", { name, arguments: args }) as Promise<
          ToolResults[N]
        >;
      },
    };
  };
  const claim = await claimProjectService(root, reuse);
  if (claim.kind === "attached")
    return remote(claim.connection, false, async () => {});
  const owner = claim;
  let git: ReturnType<typeof createGitComparison> | undefined;
  let goProcess: ChildProcess | undefined, goPort: number | undefined;
  let goExit: Promise<void> | undefined;
  let server: http.Server | undefined;
  const sockets = new Set<net.Socket>();
  const handlers = new Set<Promise<unknown>>();
  async function stopAndDrain() {
    const httpClosed =
      server &&
      new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          )
            reject(error);
          else resolve();
        });
        for (const socket of sockets) socket.destroy();
      });
    const childStopped = (async () => {
      if (!goProcess || !goExit) return;
      if (goProcess.exitCode === null && goProcess.signalCode === null) {
        goProcess.kill();
        const force = setTimeout(() => goProcess?.kill("SIGKILL"), 1000);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            goExit,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () => reject(Error("Go backend did not stop.")),
                5000
              );
            }),
          ]);
        } finally {
          clearTimeout(force);
          clearTimeout(deadline);
        }
      }
    })();
    const drained = await Promise.allSettled([
      httpClosed,
      childStopped,
      git?.close(),
      (async () => {
        while (handlers.size) await Promise.all([...handlers]);
      })(),
    ]);
    const failed = drained.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  try {
    const workspace = openWorkspace(root);
    git = createGitComparison(root);
    workspace.applyPendingNoteUpdates();
    const cache = path.join(assetsRoot, ".cache");
    if (demo) {
      if (workspace.isNew) seed(workspace);
      fs.mkdirSync(cache, { recursive: true });
      const { build } = await import("esbuild");
      await build({
        entryPoints: [path.join(root, "web/Checkout.tsx")],
        bundle: true,
        outfile: path.join(cache, "demo.js"),
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        minify: true,
        logLevel: "warning",
      });
    }
    if (demo && backend === "go") {
      console.log("Building Go example...");
      const binary = path.join(
        cache,
        process.platform === "win32" ? "checkout-go.exe" : "checkout-go"
      );
      try {
        await promisify(execFile)("go", ["build", "-o", binary, "."], {
          cwd: path.join(root, "go"),
          timeout: 120000,
        });
      } catch (e) {
        throw Error(
          "Go 1.22+ is required. Use npm start for Node instead.\n" +
            (e instanceof Error && "stderr" in e
              ? String(e.stderr)
              : errorMessage(e)),
          { cause: e }
        );
      }
      goPort = await new Promise<number>((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
          const p = (s.address() as AddressInfo).port;
          s.close((error) => (error ? reject(error) : resolve(p)));
        });
      });
      goProcess = spawn(binary, [], {
        env: { ...process.env, CODEPATH_DEMO_ADDR: "127.0.0.1:" + goPort },
        stdio: ["ignore", "ignore", "inherit"],
      });
      goExit = new Promise((resolve) => {
        goProcess!.once("close", () => resolve());
        goProcess!.on("error", (error) => {
          console.error("Go backend process error", error);
        });
      });
      for (let i = 0; i < 50; i++) {
        try {
          await fetch("http://127.0.0.1:" + goPort + "/api/orders", {
            signal: AbortSignal.timeout(800),
          });
          break;
        } catch {
          if (i === 49) throw Error("Go backend did not start.");
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    // Capture demo provenance before execution, but do not eagerly parse/hash
    // every source file merely to start an ordinary project service.
    const sourceHashes = Object.fromEntries(
      demo
        ? workspace
            .overview()
            .paths.flatMap((p) =>
              workspace
                .invoke("get_walkthrough", { id: p.id })
                .steps.flatMap((step) =>
                  step.code ? [[step.code.file, step.code.fileHash]] : []
                )
            )
        : []
    );
    const token = claim.token;
    const json = (res: http.ServerResponse, status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    async function body(req: http.IncomingMessage) {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw Error("Request exceeds 2 MiB.");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    }
    const config = { demo, backend, root, toolRoot };
    async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
      try {
        const host = req.headers.host;
        if (!["127.0.0.1:" + port, "localhost:" + port].includes(host ?? ""))
          return json(res, 403, {
            error: "Use the loopback URL printed by Codepath.",
          });
        if (
          req.headers.origin &&
          !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
            req.headers.origin
          )
        )
          return json(res, 403, { error: "Cross-origin request rejected." });
        if (req.headers["sec-fetch-site"] === "cross-site")
          return json(res, 403, { error: "Cross-site request rejected." });
        const route = new URL(req.url!, "http://" + host).pathname;
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (route.startsWith("/api/") || route.startsWith("/demo-api/")) {
          if (req.headers["x-codepath-token"] !== token)
            return json(res, 401, { error: "Local session token required." });
          if (req.method === "GET" && route === "/api/state")
            return json(res, 200, workspace.overview());
          if (req.method === "POST" && route === "/api/call") {
            const a = await body(req);
            owner.assertWritable();
            if (a.name === "get_git_viewed") {
              return json(res, 200, {
                pairs: git!
                  .viewedPairs(a.arguments?.listId)
                  .map((pair) =>
                    pair.identity
                      ? {
                          fileId: pair.fileId,
                          ...workspace.gitViewed(pair.identity),
                        }
                      : {
                          fileId: pair.fileId,
                          disabledReason: pair.disabledReason,
                          viewed: false,
                        }
                  ),
              });
            }
            if (a.name === "set_git_viewed") {
              const input = viewedMarkRequest(a.arguments);
              const identity = await git!.admitViewed(
                input.query,
                input.fileId,
                input.identity
              );
              owner.assertWritable();
              return json(
                res,
                200,
                workspace.setGitViewed(identity, input.expectedRevision)
              );
            }
            if (a.name === "save_walkthrough_comparison_note") {
              const input = parseWalkthroughComparisonNote(a.arguments);
              const source = workspace.comparisonSource(
                input.walkthroughId,
                input.stepId,
                input.binding
              );
              const admitted = await git!.fresh(
                source.query,
                source.fileId,
                source.binding
              );
              owner.assertWritable();
              return json(
                res,
                200,
                workspace.saveWalkthroughComparisonNote(
                  input,
                  admitted.views[0]
                )
              );
            }
            if (a.name === "create_comparison_walkthrough") {
              const input = parseComparisonAuthoring(a.arguments);
              const admitted = await git!.admit(input.listId, input.steps);
              owner.assertWritable();
              return json(
                res,
                200,
                workspace.createComparisonWalkthrough(
                  input,
                  admitted.query,
                  admitted.views
                )
              );
            }
            if (a.name === "check_git_comparison")
              return json(res, 200, await git!.check(a.arguments?.listId));
            if (a.name === "list_git_branches")
              return json(res, 200, await git!.branches());
            if (a.name === "list_git_changes")
              return json(
                res,
                200,
                await git!.list(a.arguments?.query, a.arguments?.cursor)
              );
            if (a.name === "get_git_file") {
              const view = await git!.file(
                a.arguments?.listId,
                a.arguments?.fileId
              );
              owner.assertWritable();
              const context = (side: typeof view.before) =>
                functionContext(
                  side.content !== undefined &&
                    sourceExtensions.has(path.extname(side.file))
                    ? parseFile(side.file, side.content).functionScopes
                    : undefined,
                  side.content ?? "",
                  1,
                  side.code?.lines.length ?? 1
                );
              return json(res, 200, {
                ...view,
                functionContexts: {
                  before: context(view.before),
                  after: context(view.after),
                },
                annotations: workspace.comparisonNotes(
                  view.scope,
                  view.binding
                ),
              });
            }
            if (a.name === "save_comparison_note") {
              const view = await git!.file(
                a.arguments?.listId,
                a.arguments?.fileId
              );
              owner.assertWritable();
              return json(
                res,
                200,
                workspace.saveComparisonNote(view, a.arguments)
              );
            }
            owner.assertWritable();
            return json(res, 200, workspace.invoke(a.name, a.arguments));
          }
          if (demo && req.method === "POST" && route === "/demo-api/orders") {
            const input = await body(req);
            owner.assertWritable();
            let result: { status: number; body: Record<string, unknown> };
            if (backend === "go") {
              const r = await fetch(
                "http://127.0.0.1:" + goPort + "/api/orders",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(input),
                  signal: AbortSignal.timeout(5000),
                }
              );
              result = {
                status: r.status,
                body: (await r.json()) as Record<string, unknown>,
              };
            } else
              result = handleOrder({
                method: "POST",
                path: "/api/orders",
                body: input,
              });
            return json(res, result.status, {
              ...result.body,
              walkthroughId: "checkout-" + backend,
            });
          }
          if (demo && req.method === "POST" && route === "/api/demo/capture") {
            const a = await body(req);
            if (a.walkthroughId !== "checkout-" + backend)
              throw Error("Unexpected demo path.");
            owner.assertWritable();
            const p = workspace.invoke("get_walkthrough", {
              id: a.walkthroughId,
            });
            const events = (a.events as RunEvent[]).map((e) => {
              const step = p.steps.find((s) => s.id === e.stepId);
              return {
                ...e,
                sourceHash: step ? sourceHashes[step.source.file] : undefined,
              };
            });
            owner.assertWritable();
            return json(
              res,
              200,
              workspace.invoke("record_run", {
                walkthroughId: p.id,
                label: a.label,
                mode: "recorded",
                origin:
                  "Selected values from instrumented React + " +
                  backend +
                  " execution.",
                events,
              })
            );
          }
          return json(res, 404, { error: "Endpoint not found." });
        }
        if (req.method !== "GET")
          return json(res, 405, { error: "Method not allowed." });
        const nonce = crypto.randomBytes(12).toString("hex");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'nonce-" +
            nonce +
            "'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; connect-src 'self'"
        );
        if (route === "/" || (demo && route === "/demo")) {
          let html = fs.readFileSync(
            path.join(assetsRoot, route === "/demo" ? "demo.html" : "ui.html"),
            "utf8"
          );
          const injection =
            '<script nonce="' +
            nonce +
            '">window.CODEPATH_TOKEN=' +
            JSON.stringify(token) +
            ";window.CODEPATH_CONFIG=" +
            JSON.stringify(config).replaceAll("<", "\\u003c") +
            ";</script>";
          html = html.replace("<!--CONFIG-->", injection);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          return res.end(html);
        }
        const assets: Record<string, [string, string]> = {
            "/ui.js": ["ui.js", "text/javascript"],
            "/style.css": ["style.css", "text/css"],
            ...(demo
              ? { "/demo.js": [".cache/demo.js", "text/javascript"] }
              : {}),
          },
          asset = assets[route];
        if (!asset) return json(res, 404, { error: "Not found." });
        res.writeHead(200, {
          "Content-Type": asset[1] + "; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(path.join(assetsRoot, asset[0])).pipe(res);
      } catch (e) {
        if (!res.headersSent) json(res, 400, { error: errorMessage(e) });
        else res.end();
      }
    }
    server = http.createServer((req, res) => {
      const pending = handle(req, res);
      handlers.add(pending);
      void pending.then(
        () => handlers.delete(pending),
        (error) => {
          handlers.delete(pending);
          res.destroy(error instanceof Error ? error : undefined);
        }
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.requestTimeout = 15000;
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      let tries = 0;
      const listen = () => {
        try {
          listener.listen(port, "127.0.0.1", () => {
            port = (listener.address() as AddressInfo).port;
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      };
      listener.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && !strictPort && ++tries < 10) {
          port++;
          listen();
        } else reject(e);
      });
      listen();
    });
    claim.publish(port);
    return remote({ port, token }, true, () => claim.close(stopAndDrain));
  } catch (error) {
    try {
      await claim.close(stopAndDrain);
    } catch (cleanupError) {
      console.error("Service cleanup failed", cleanupError);
    }
    throw error;
  }
}
