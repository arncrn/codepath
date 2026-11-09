import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTlc, modelConfig } from "./tlc.mjs";
import {
  reviewedSource,
  sourceCorrespondence,
  mutateSource,
} from "./source-contract.mjs";

const [runner, out] = process.argv.slice(2);
assert.ok(
  runner && out && process.argv.length === 4,
  "Usage: node scripts/formal/statechart-service-ownership.mjs /path/to/statechart /new/external/output"
);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
assert.ok(
  !path.resolve(out).startsWith(path.resolve(projectRoot) + path.sep),
  "Statechart work belongs in external scratch, not the repository."
);
assert.ok(!fs.existsSync(out), "Use a new output directory.");
fs.mkdirSync(out, { recursive: true });
const sources = reviewedSource(projectRoot),
  tool = await getTlc(projectRoot);
const invariants = [
  "AtMostOneLiveOwner",
  "AcceptedPathsPreserved",
  "ForeignConnectionPreserved",
];
const cases = [
  { name: "reviewed-source", source: sources, exit: 0 },
  { name: "protocol-view", source: sources, exit: 0, protocolView: true },
  ...["no-op-reservation", "premature-snapshot", "removed-token-guard"].map(
    (name) => ({ name, source: mutateSource(sources, name), exit: 1 })
  ),
  {
    name: "failed-probe-freshness",
    source: mutateSource(sources, "premature-snapshot"),
    exit: 1,
    actionConstraint: "FailedProbeFreshnessSchedule",
  },
];
for (const entry of cases) {
  const directory = path.join(out, entry.name);
  fs.mkdirSync(directory);
  const spec = path.join(directory, "ServiceOwnership.tla");
  const config = path.join(directory, "ServiceOwnership.cfg");
  const view = path.join(directory, "view.mjs");
  fs.copyFileSync(
    path.join(projectRoot, "formal/service-ownership/ServiceOwnership.tla"),
    spec
  );
  fs.copyFileSync(
    path.join(projectRoot, "formal/service-ownership/view.mjs"),
    view
  );
  fs.writeFileSync(
    config,
    modelConfig(
      sourceCorrespondence(entry.source),
      entry.actionConstraint ? ["AcceptedPathsPreserved"] : invariants,
      entry.actionConstraint
    ) + (entry.protocolView ? "CONSTRAINT ProtocolOnlyView\n" : "")
  );
  let result;
  try {
    result = await promisify(execFile)(
      runner,
      [
        spec,
        "--config",
        config,
        "--view",
        view,
        "--out",
        path.join(directory, "report"),
      ],
      {
        env: { ...process.env, JAVA: tool.java, TLA2TOOLS: tool.jar },
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    result.code = 0;
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    result = error;
  }
  fs.writeFileSync(
    path.join(directory, "runner.log"),
    result.stdout + result.stderr
  );
  assert.equal(
    result.code,
    entry.exit,
    `Unexpected statechart verdict for ${entry.name}: ${result.stdout}\n${result.stderr}`
  );
  console.log(`${entry.name}: ${path.join(directory, "report/report.md")}`);
}
