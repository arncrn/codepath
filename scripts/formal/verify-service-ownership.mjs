import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTlc, checkInvariant, modelConfig } from "./tlc.mjs";
import {
  reviewedSource,
  sourceCorrespondence,
  mutateSource,
} from "./source-contract.mjs";
import { replayServiceOwnership } from "./replay-service-ownership.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const mutationCheck = process.argv.slice(2).includes("--mutation-check");
assert.ok(
  process.argv.slice(2).every((argument) => argument === "--mutation-check"),
  "Unknown verification argument."
);
const sources = reviewedSource(projectRoot);
const synchronization = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "formal/service-ownership/coverage.json"),
    "utf8"
  )
);
const tool = await getTlc(projectRoot);
const output = path.join(
  projectRoot,
  ".cache/formal-verification/runs",
  new Date().toISOString().replace(/[:.]/g, "-") +
    (mutationCheck ? "-mutation" : "")
);
fs.mkdirSync(output, { recursive: true });
console.log(`Evidence: ${path.relative(projectRoot, output)}`);
const invariants = [
  "AtMostOneLiveOwner",
  "AcceptedPathsPreserved",
  "ForeignConnectionPreserved",
];
async function verify(label, source) {
  const correspondence = sourceCorrespondence(source);
  const directory = path.join(output, label);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, "ServiceOwnership.cfg"),
    modelConfig(correspondence, invariants)
  );
  const replay = await replayServiceOwnership(projectRoot, source);
  fs.writeFileSync(
    path.join(directory, "replay.json"),
    JSON.stringify(replay, null, 2) + "\n"
  );
  const results = [];
  for (const invariant of invariants) {
    const model = await checkInvariant(
      projectRoot,
      tool,
      invariant,
      correspondence
    );
    fs.writeFileSync(path.join(directory, `${invariant}.log`), model.log);
    const scenarios = replay.scenarios.filter(
      (scenario) => invariant in (scenario.invariants || {})
    );
    assert.ok(
      scenarios.length,
      `Missing actual-source scenario for ${invariant}`
    );
    const realPassed = scenarios.every(
      (scenario) => scenario.invariants[invariant]
    );
    assert.equal(
      realPassed,
      model.passed,
      `Model and real code disagree for ${label}/${invariant}. Review correspondence and schedules.`
    );
    const evidence = { ...model };
    delete evidence.log;
    results.push({
      ...evidence,
      scenarios: scenarios.map((scenario) => ({
        scenario: scenario.scenario,
        passed: scenario.invariants[invariant],
      })),
    });
    console.log(
      `${label} ${model.passed ? "PASS" : "VIOLATION"} ${invariant}; ` +
        `${model.distinctStates} distinct states; shortest counterexample ${model.shortestCounterexampleTransitions ?? "none"}.`
    );
  }
  const freshness = await checkInvariant(
    projectRoot,
    tool,
    "AcceptedPathsPreserved",
    correspondence,
    { actionConstraint: "FailedProbeFreshnessSchedule" }
  );
  fs.writeFileSync(
    path.join(directory, "failed-probe-freshness.log"),
    freshness.log
  );
  fs.writeFileSync(
    path.join(directory, "failed-probe-freshness.cfg"),
    modelConfig(
      correspondence,
      ["AcceptedPathsPreserved"],
      "FailedProbeFreshnessSchedule"
    )
  );
  assert.equal(
    freshness.passed,
    replay.scenarios.find(
      (scenario) => scenario.scenario === "failed-probe-freshness"
    ).invariants.AcceptedPathsPreserved,
    "Failed-probe-specific model and actual-source replay disagree."
  );
  if (!freshness.passed) {
    assert.ok(
      freshness.actions.includes("ProbeRecordChanged"),
      "The targeted freshness counterexample must include the old-owner probe reread."
    );
  }
  const freshnessResult = { ...freshness };
  delete freshnessResult.log;
  console.log(
    `${label} failed-probe schedule ${freshness.passed ? "PASS" : "VIOLATION"}; ` +
      `${freshness.distinctStates} distinct states; shortest counterexample ${freshness.shortestCounterexampleTransitions ?? "none"}.`
  );
  const result = {
    label,
    correspondence,
    results,
    freshness: freshnessResult,
    replay,
  };
  fs.writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify(result, null, 2) + "\n"
  );
  return result;
}
const baseline = await verify("reviewed-source", sources);
assert.ok(
  baseline.results.every((result) => result.passed),
  "BUG: the reviewed source violates a safety invariant. Read model and actual replay evidence."
);
const mutations = [];
if (mutationCheck) {
  const expected = {
    "no-op-reservation": ["AtMostOneLiveOwner", "AcceptedPathsPreserved"],
    "premature-snapshot": ["AcceptedPathsPreserved"],
    "removed-token-guard": ["ForeignConnectionPreserved"],
  };
  for (const [mutation, broken] of Object.entries(expected)) {
    const result = await verify(mutation, mutateSource(sources, mutation));
    for (const invariant of invariants)
      assert.equal(
        result.results.find((entry) => entry.invariant === invariant).passed,
        !broken.includes(invariant),
        `${mutation} must have its precise expected effect on ${invariant}.`
      );
    mutations.push(result);
  }
}
const summary = {
  tool: { release: tool.version, checker: baseline.results[0].checkerVersion },
  syncCommit: synchronization.syncCommit,
  privateSnapshotSha: synchronization.privateSnapshotSha,
  privateSnapshotIsAppCommit: synchronization.privateSnapshotIsAppCommit,
  mode: mutationCheck
    ? "scratch-only sensitivity checks"
    : "bounded safety and actual-source agreement",
  baseline,
  mutations,
};
fs.writeFileSync(
  path.join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n"
);
console.log(
  mutationCheck
    ? "PASS all scratch mutations caught by TLC and actual code."
    : "PASS all finite-model invariants and actual-source scenarios agree."
);
