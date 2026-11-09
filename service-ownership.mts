import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ServiceConnection {
  port: number;
  token: string;
}
type Claim =
  | { kind: "attached"; connection: ServiceConnection }
  | {
      kind: "owner";
      token: string;
      publish(port: number): void;
      assertWritable(): void;
      close(stopAndDrain: () => Promise<void>): Promise<void>;
    };
type Snapshot = { text: string; identity: string } | undefined;

function noSymlink(file: string) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error(file + " cannot be a symlink.");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
function readConnection(root: string): Snapshot {
  noSymlink(path.join(root, ".codepaths"));
  const file = path.join(root, ".codepaths/connection.json");
  const stat = noSymlink(file);
  if (!stat) return;
  if (!stat.isFile()) throw Error("Connection must be a regular file.");
  return {
    text: fs.readFileSync(file, "utf8"),
    identity: [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs].join(":"),
  };
}
function same(a: Snapshot, b: Snapshot) {
  return a?.text === b?.text && a?.identity === b?.identity;
}
function parse(snapshot: Snapshot): Record<string, unknown> | undefined {
  if (!snapshot) return;
  try {
    const value: unknown = JSON.parse(snapshot.text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}
function usable(
  c: Record<string, unknown> | undefined
): c is Record<string, unknown> & ServiceConnection {
  return (
    !!c &&
    Number.isInteger(c.port) &&
    Number(c.port) > 0 &&
    Number(c.port) <= 65535 &&
    typeof c.token === "string"
  );
}
function dead(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  return false;
}
async function discover(root: string, deadline: number) {
  while (Date.now() < deadline) {
    const snapshot = readConnection(root),
      c = parse(snapshot);
    if (!usable(c)) return { snapshot, active: undefined };
    let healthy = false;
    try {
      const response = await fetch(
        "http://127.0.0.1:" + c.port + "/api/state",
        {
          headers: { "X-Codepath-Token": c.token },
          signal: AbortSignal.timeout(800),
        }
      );
      healthy =
        response.ok &&
        ((await response.json()) as { root?: string }).root === root;
    } catch {
      // An unavailable endpoint is not evidence that its writer has died.
    }
    if (!same(snapshot, readConnection(root))) continue;
    if (healthy) return { snapshot, active: c };
    if (!dead(c.pid))
      throw Error(
        "Project owner is still live or its PID is unknown; refusing takeover."
      );
    return { snapshot, active: undefined };
  }
  throw Error("Project connection kept changing; retry startup.");
}
function release(reservation: net.Server) {
  return new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function claimProjectService(
  root: string,
  reuse: boolean
): Promise<Claim> {
  const deadline = Date.now() + 2500;
  const reservationPort =
    16384 +
    (crypto
      .createHash("sha256")
      .update("codepath-owner-v1\0" + root)
      .digest()
      .readUInt32BE(0) %
      32768);
  const attached = (connection: ServiceConnection): Claim => {
    if (!reuse)
      throw Error(
        "Project already open at http://127.0.0.1:" + connection.port
      );
    return { kind: "attached", connection };
  };
  while (Date.now() < deadline) {
    const observed = await discover(root, deadline);
    if (observed.active) return attached(observed.active);
    const token = crypto.randomBytes(24).toString("hex");
    const reservation = net.createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(
          { host: "127.0.0.1", port: reservationPort, exclusive: true },
          () => {
            reservation.removeListener("error", reject);
            resolve();
          }
        );
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await delay(25);
      continue;
    }
    let current: Awaited<ReturnType<typeof discover>>;
    try {
      current = await discover(root, Date.now() + 2500);
      if (current.active) {
        const result = attached(current.active);
        await release(reservation);
        return result;
      }
    } catch (error) {
      try {
        await release(reservation);
      } catch (cleanupError) {
        console.error("Reservation cleanup failed", cleanupError);
      }
      throw error;
    }
    const expected = current.snapshot;
    let phase: "reserved" | "published" | "closing" | "closed" = "reserved";
    let closing: Promise<void> | undefined;
    return {
      kind: "owner",
      token,
      assertWritable() {
        if (phase !== "published")
          throw Error("Project service is not accepting writes.");
      },
      publish(port) {
        if (phase !== "reserved")
          throw Error("Project service cannot publish now.");
        const connection = path.join(root, ".codepaths/connection.json");
        if (!same(expected, readConnection(root)))
          throw Error(
            "Connection changed during startup; refusing replacement."
          );
        const temporary = connection + "." + token + ".tmp";
        let descriptor: number | undefined = fs.openSync(
          temporary,
          "wx",
          0o600
        );
        try {
          fs.writeFileSync(
            descriptor,
            JSON.stringify({ port, token, root, pid: process.pid }) + "\n"
          );
          fs.closeSync(descriptor);
          descriptor = undefined;
          if (!same(expected, readConnection(root)))
            throw Error(
              "Connection changed during publication; refusing replacement."
            );
          fs.renameSync(temporary, connection);
          phase = "published";
        } catch (error) {
          try {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            fs.unlinkSync(temporary);
          } catch (cleanupError) {
            console.error(
              "Connection publication cleanup failed",
              cleanupError
            );
          }
          throw error;
        }
      },
      close(stopAndDrain) {
        if (closing) return closing;
        phase = "closing";
        closing = (async () => {
          await stopAndDrain();
          const connection = path.join(root, ".codepaths/connection.json");
          let cleanupError: unknown;
          try {
            if (parse(readConnection(root))?.token === token)
              fs.unlinkSync(connection);
          } catch (error) {
            cleanupError = error;
          }
          await release(reservation);
          phase = "closed";
          if (cleanupError) throw cleanupError;
        })();
        return closing;
      },
    };
  }
  throw Error("Project ownership reservation is busy; retry startup.");
}
