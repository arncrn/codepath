import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const toolsRelease = "1.7.4";
const expectedChecksum =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export async function getTlc(projectRoot) {
  const java = process.env.JAVA || "java";
  const version = await execute(java, ["-version"], { timeout: 10000 });
  const major = Number(
    (version.stderr + version.stdout).match(/version "(\d+)/)?.[1]
  );
  if (!Number.isInteger(major) || major < 11)
    throw Error(
      "Formal verification requires Java 11 or later (or set JAVA to its executable)."
    );
  const directory = path.join(projectRoot, ".cache/formal-verification/tools");
  const jar =
    process.env.TLA2TOOLS_JAR ||
    path.join(directory, `tla2tools-${toolsRelease}.jar`);
  if (process.env.TLA2TOOLS_JAR && !fs.existsSync(jar))
    throw Error("TLA2TOOLS_JAR must name an existing checksum-matching jar.");
  if (!fs.existsSync(jar)) {
    const response = await fetch(
      `https://github.com/tlaplus/tlaplus/releases/download/v${toolsRelease}/tla2tools.jar`,
      { signal: AbortSignal.timeout(60000) }
    );
    if (!response.ok)
      throw Error(`TLC download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== expectedChecksum)
      throw Error("TLC download checksum mismatch.");
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${jar}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
      fs.renameSync(temporary, jar);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  if (sha256(fs.readFileSync(jar)) !== expectedChecksum)
    throw Error(
      "Cached TLC checksum mismatch; remove the corrupted cached JAR and retry."
    );
  return { java, jar, version: toolsRelease };
}

export function modelConfig(correspondence, invariants, actionConstraint) {
  const constants = Object.entries(correspondence).map(
    ([key, value]) => ` ${key} = ${value ? "TRUE" : "FALSE"}`
  );
  return [
    "CONSTANTS",
    " Participants = {first, second}",
    " NoOwner = nobody",
    " Foreign = foreignRecord",
    ...constants,
    "INIT Init",
    "NEXT Next",
    `INVARIANTS TypeOK ${invariants.join(" ")}`,
    ...(actionConstraint ? [`ACTION_CONSTRAINT ${actionConstraint}`] : []),
    "",
  ].join("\n");
}

export async function checkInvariant(
  projectRoot,
  tool,
  invariant,
  correspondence,
  { actionConstraint } = {}
) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tlc-"));
  try {
    const model = "ServiceOwnership";
    fs.copyFileSync(
      path.join(projectRoot, `formal/service-ownership/${model}.tla`),
      path.join(scratch, `${model}.tla`)
    );
    fs.writeFileSync(
      path.join(scratch, `${model}.cfg`),
      modelConfig(correspondence, [invariant], actionConstraint)
    );
    let stdout, stderr, exitCode;
    try {
      ({ stdout, stderr } = await execute(
        tool.java,
        [
          "-Xmx256m",
          "-XX:+UseParallelGC",
          "-cp",
          tool.jar,
          "tlc2.TLC",
          "-workers",
          "1",
          "-cleanup",
          "-config",
          `${model}.cfg`,
          `${model}.tla`,
        ],
        { cwd: scratch, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }
      ));
      exitCode = 0;
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      ({ stdout, stderr } = error);
      exitCode = error.code;
    }
    const log = stdout + stderr;
    const violated = log.includes(`Error: Invariant ${invariant} is violated.`);
    const passed =
      exitCode === 0 &&
      log.includes("Model checking completed. No error has been found.");
    if (!passed && !violated)
      throw Error(`TLC did not establish a verdict for ${invariant}:\n${log}`);
    if (log.includes("Error: Invariant TypeOK is violated."))
      throw Error(`Modeling error: TypeOK failed.\n${log}`);
    const states = log.match(
      /(\d+) states generated, (\d+) distinct states found/
    );
    const trace = [...log.matchAll(/^State (\d+): <([^\n]+)>/gm)];
    return {
      invariant,
      passed,
      checkerVersion: log.match(/TLC2 Version ([\d.]+)/)?.[1] ?? null,
      generatedStates: states ? Number(states[1]) : null,
      distinctStates: states ? Number(states[2]) : null,
      shortestCounterexampleTransitions: violated ? trace.length - 1 : null,
      actions: trace.slice(1).map((match) => match[2].split(" line ")[0]),
      log,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
