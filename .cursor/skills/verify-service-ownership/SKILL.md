---
name: verify-service-ownership
description: Verify Codepath service ownership and accepted-save preservation after changes to startup, discovery, ownership reservation, snapshot loading, HTTP write admission, connection publication, or close/drain. Runs bounded TLA+ checks, actual-source HTTP/disk replays, and scratch mutations.
---

# Verify service ownership and accepted saves

## Read the reviewed boundary

Read these files before changing covered behavior.

1. `formal/service-ownership/README.md`.
2. `formal/service-ownership/coverage.json`.
3. `formal/service-ownership/ServiceOwnership.tla` and `ServiceOwnership.cfg`.
4. `scripts/formal/source-contract.mjs`, `replay-service-ownership.mjs`, `replay-worker.mjs`, and `verify-service-ownership.mjs`.
5. Actual `service.mts`, `service-ownership.mts`, and `workspace.mts`.

Preserve these safety promises.

- `AtMostOneLiveOwner`. Same-root overlapping starts cannot return independent writable owners.
- `AcceptedPathsPreserved`. Every acknowledged new path remains on disk after later saves, absent deletion.
- `ForeignConnectionPreserved`. Owner close cannot remove a connection with a different token.

Covered code includes service claim ordering, attached handles, real listener readiness, publication, post-await write admission, handler tracking and drainage, helper discovery/rechecks, exclusive reservation lifetime, token-identity cleanup, and synchronous whole-workspace save. The action and function mappings are in `coverage.json`.

Record the actual application commit whose covered source matches the reviewed files in `syncCommit`, alongside exact SHA-256 fingerprints and semantic/AST correspondence. Use null only if there is no matching application commit. The 0.8.0 review anchors to published application commit `50147c72ea7f3731ac9093f765e77b8213178f07`; the subsequent read-only authoring-validation changes are uncommitted and correctly use null until a matching application commit exists. The older private snapshot `903acefa0cdfc7569aa017ca7d85449e8ff11865` is not an application commit. Do not treat a matching fingerprint as proof of correspondence. If covered source changes, read the changes and yield points before updating hashes or model behavior. Include the helper in that review. The old `unlinkConnection` no longer exists.

## Run the main check

Use the supported Node version, existing dependencies, and Java 11 or later. Do not install dependencies into a shared checkout. `JAVA` can select Java. The tool uses a checksum-pinned cached TLA+ tools release 1.7.4 jar, whose internal TLC version is 2.19. `TLA2TOOLS_JAR` can select a matching existing jar.

```sh
npm run verify:formal
```

Read the printed evidence directory and its `summary.json`, replay results, source-derived configs, and per-invariant TLC logs. The reviewed finite model currently reaches 893 states. All three properties and the supplementary failed-probe schedule must pass. Any actual replay error or model/replay disagreement fails the command.

The replay compiles scratch copies of actual service, helper, and workspace. It must import the scratch helper, including its mutations. Never replace saves with fake successful responses or substitute a reviewed helper when replaying a mutated helper.

Inspect all actual scenarios.

- Two real child processes overlap. A's real HTTP listen callback waits while B invokes startup. B must contend on the reservation, then attach to the same published URL. Both acknowledged IDs must remain on disk.
- B's real authenticated old-owner probe waits while A saves and closes in a still-live PID. Resume the actual fetch. B must recover after the connection reread, load fresh state after claiming, save, and retain A's accepted ID.
- A bounded external action replaces the connection with a foreign token before close. It is not a second protocol-respecting owner. Close and repeated close must preserve those exact bytes.
- A real incomplete POST body must not receive a successful acknowledgement after close or persist a pending path. This runtime scenario is not another formal invariant.

Do not require two fixed listeners to become ready. Fixed B attaches. The no-reservation negative control uses both actual processes' final publication-check barriers before atomic renames. A same-event-loop schedule can miss that race because publication has another identity check.

## Check sensitivity

```sh
npm run verify:formal:mutation
```

This first rechecks the reviewed source. It then changes scratch source and derives model constants from AST structure, not independent expected-result switches.

- `no-op-reservation` removes the awaited reservation bind and makes release a no-op for the resulting unbound server. Both TLC and actual overlap replay must find duplicate owners and accepted-save loss.
- `premature-snapshot` moves the actual workspace load before the awaited claim while retaining reservation exclusion. Both TLC and the failed-probe replay must lose an accepted path.
- `removed-token-guard` replaces the helper's actual token comparison with `true`. Both TLC and the foreign-record replay must detect removal.

The unrestricted shortest counterexamples have 16, 20, 25, and 13 transitions respectively. The additional failed-probe-constrained snapshot trace has 27 transitions and must include the changed-record reread. Use newly generated counts after any model change. Do not hardcode old graph counts into assertions.

Unexpected errors are not successful mutation catches. Do not reverse assertions or weaken properties. No extra close/drain mutation failure is promised. If another fence prevents a proposed mutation from violating these properties, report that limit.

## Read the statecharts

Read the current `/statechart` skill and use its runner. Then run this wrapper with that runner's absolute path and a new external scratch folder.

```sh
node scripts/formal/statechart-service-ownership.mjs /absolute/path/to/statechart /new/external/output
```

The wrapper sets `TLA2TOOLS` and `JAVA` for the runner, so no mise setup is needed. It checks the full model, a constrained protocol display, all three source-derived mutations, and the failed-probe-specific snapshot schedule. Inspect every generated `report.md`, `chart.mmd` when present, and TLC trace. Show the generated Mermaid text when handing off a chart.

The full passing graph exceeds the runner's 500-state drawing budget and produces a report without a chart. The optional protocol display has 460 states and excludes exploration beyond the foreign-replacement boundary. It is a visualization, not reduced proof scope. Mutation charts show shortest violating paths. The view coalesces unchanged labels, hides terminal stuttering, and keeps different violated-rule combinations distinct. Keep generated charts, reports, configs and TLC output in external scratch or ignored `.cache/`, not in committed source. Retain the maintained model, main config, view, coverage correspondence and scripts under version control.

## Judge and synchronize

Main exit 0 means the finite model and every named real scenario pass. Mutation exit 0 means the specified scratch breaks were caught by both model and real code. Neither result is an unbounded proof.

The finite boundary is two canonical same-root callers, one start and one unique accepted new path each, one pending request each, distinct tokens, and one external foreign record before close. Individual filesystem actions are atomic assumptions. Publication comparison and rename are distinct across processes. Healthy networking can fail a probe when its old listener closes. Live unchanged records fail closed. Busy retries and blocked terminal attempts do not promise eventual progress. `Done` permits legitimate terminal stuttering; deadlock checking remains enabled.

The model does not prove OS reservation semantics, crash safety, durability after power loss, arbitrary filesystem interference, cross-host locking, legacy concurrent starts, demo subprocess drainage, notes/runs semantics, or unbounded topology. Separate runtime process and crash tests are not formal coverage.

After verification changes, run both npm commands and the statechart wrapper, then follow this skill again from its read step. Record each invariant as in sync, updated, bug, or blocked. Keep source hashes, AST correspondence, action mappings, README results, and generated evidence together. For stale verification use `/maintain-formal-verification-skill`. Report a real source bug without editing production code or weakening the check.
