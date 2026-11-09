# Service ownership and accepted saves

## Result

All three safety invariants hold in the updated finite model and actual-source replays. The model has 893 reachable states. The initial maintenance run stopped on source-fingerprint drift, before TLC. That was verification drift, not a product failure.

| Invariant                    | Promise                                                                          | Reviewed source |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------- |
| `AtMostOneLiveOwner`         | Two starts cannot return independent writable owners for one canonical root.     | Pass            |
| `AcceptedPathsPreserved`     | Every acknowledged new path remains on disk after another save, absent deletion. | Pass            |
| `ForeignConnectionPreserved` | Close cannot remove a connection with a different token.                         | Pass            |

The properties retain their original definitions. The production change moves ownership into `service-ownership.mts` and loads the writable workspace after the claim. This verification update changes the described transitions, not the promises.

## Note-presentation synchronization

For 0.7.1, the parent reviewed the workspace's read-only capability field and shared note-history snapshot helper against the exact prior fingerprint. Service/helper bytes, ownership ordering, synchronous invoke/save and atomic rename are unchanged. The source-derived ownership checks, main/mutation replays and all six statechart runs pass again with the same finite bounds and state counts. Presentation and note-history semantics have separate runtime tests; they are not added formal coverage. The maintained correspondence is recorded in `coverage.json`; temporary working reports are not retained in the repository.

## Commands and evidence

```sh
npm run verify:formal
npm run verify:formal:mutation
node scripts/formal/statechart-service-ownership.mjs /absolute/path/to/statechart /new/external/output
```

Use supported Node and Java 11 or later. Existing project dependencies suffice. No dependency installation is part of verification. `JAVA` selects Java. `TLA2TOOLS_JAR` can select an existing checksum-matching jar. Otherwise the verifier uses its pinned cache or downloads TLA+ tools release 1.7.4. Its internal TLC version is 2.19, not 1.7.4.

Each main or mutation run prints its evidence directory under ignored `.cache/formal-verification/runs/`. Generated logs, tool downloads, summaries and diagrams are disposable and are not committed; rerun these commands when fresh evidence is needed. The directory contains source-derived configs, complete per-invariant TLC logs, actual replay results, scratch compilation fingerprints, and `summary.json`. Unexpected runtime errors, cleanup errors, source drift, model errors, and model/replay disagreements fail the command. A safety violation fails the main command. Mutation success means the specified breaks were caught, not that mutated code is safe.

`coverage.json` records reviewed files, functions, AST correspondence, action mappings, limits, and SHA-256 values. `syncCommit` remains null because the actual parent HEAD is unborn. Private snapshot `903acefa0cdfc7569aa017ca7d85449e8ff11865` identifies this maintenance checkout's baseline only. It is not an application sync commit.

## Transitions and real replays

The model separates discovery, exclusive reservation acquisition, discovery recheck, fresh workspace loading, HTTP readiness, publication comparison, publication rename, request-body admission, synchronous save, close admission, HTTP stop, handler drain, token cleanup, and final reservation release. Attached close is non-owning. Failed unchanged-record probes with live PIDs fail closed. Changed records trigger discovery again before liveness interpretation.

Individual filesystem writes and renames are atomic assumptions. A comparison followed by rename is not one indivisible operation across processes. `CheckPublication` and `PublishConnection` therefore remain separate. In a single event loop, the publication comparison alone can reject a second publisher after reservation removal. The overlap replay uses two real child processes to exercise the remaining check/rename race instead of inventing an asynchronous yield inside synchronous product code.

The replay compiles actual scratch copies of service, helper, and workspace. The service imports that compiled scratch helper, including mutations. Other compiled dependencies come from the normal build. HTTP, authentication, body parsing, workspace invocation, persistence, and disk inspection are real.

- Overlap pauses A's real HTTP listen callback before publication and invokes B. Fixed B hits the real reservation's `EADDRINUSE`, then probes and attaches to A at the same published URL. Both callers save one distinct path. Both IDs must remain on disk.
- Without reservation, both child listeners can become ready. Both final publication checks run before either atomic rename. A publishes and saves, then B publishes and saves from its independent snapshot. The replay observes two owners and only B's accepted path on disk.
- Freshness pauses B immediately before its real authenticated old-owner probe. A saves successfully and closes while its PID stays alive. B's real fetch then fails, rereads the removed record, claims, loads, publishes, and saves. A's path must remain.
- Cleanup atomically installs one external foreign-token record before owner close. This is a foreign record, not a second protocol-respecting writer. Two legitimate fixed owners cannot simultaneously publish. Close and repeated close must preserve the exact foreign bytes.
- A separate incomplete-POST replay closes the service while body parsing waits. The socket must disconnect or return failure, with no accepted pending save. This is runtime evidence, not an additional formal invariant or an exhaustive shutdown proof.

## Mutation sensitivity

Every mutation changes scratch source first. AST inspection derives the model constants from those changed sources. No independent command-line behavior switches select the expected answer. All three invariants and every replay run for every mutation.

| Scratch mutation      | Complete graph states | Violations and shortest transition counts | States reached before first violation |
| --------------------- | --------------------: | ----------------------------------------- | ------------------------------------- |
| No mutation           |                   893 | None                                      | Not applicable                        |
| `no-op-reservation`   |                  3065 | Ownership, 16. Accepted paths, 20.        | Ownership, 729. Paths, 1450.          |
| `premature-snapshot`  |                  1171 | Accepted paths, 25.                       | Paths, 1049.                          |
| `removed-token-guard` |                   949 | Foreign connection, 13.                   | Foreign connection, 217.              |

The no-op mutation replaces the awaited reservation bind with `await Promise.resolve()` and replaces the entire `release` body with `return Promise.resolve()`. The second change prevents an unrelated unbound-server close error from masking the intended race. Discovery, publication identity checks, HTTP, saves, and token cleanup remain actual code.

The snapshot mutation moves the exact `openWorkspace(root)` declaration before awaited claim acquisition and removes its old declaration. Mutual exclusion remains intact. The token mutation replaces only the helper condition `parse(readConnection(root))?.token === token` with `true`.

The unrestricted premature-snapshot counterexample has 25 transitions and need not probe. A supplementary action-constrained check requires the first accepted save to occur while the other caller probes that owner. Its shortest loss path has 27 transitions and includes `ProbeRecordChanged` after save, close, and release. TLC reaches 657 states before that violation. The complete constrained mutant graph has 709 states. The same constrained check passes on reviewed source with 709 states.

No extra close/drain mutation verdict is claimed. The required three mutations establish only their listed sensitivity. An independent socket fence can mask a removed phase fence, so failure of one fence is not automatically a counterexample to these three invariants.

## Statecharts

Use the statechart command above to generate configs, reports, Mermaid diagrams and TLC traces into a new external scratch folder. These outputs are not maintained source and are not checked into Git. The model (`ServiceOwnership.tla`), its main config, `view.mjs`, `coverage.json` and verification scripts are retained.

The last reviewed full run reached 893 states and passed all invariants plus deadlock checking; the runner's 500-state drawing budget prevented a complete chart. The optional `ProtocolOnlyView` display reached 460 states, shown as 12 states and 22 arrows. It coalesced 570 same-label steps and hid 23 terminal stutters. This constrained display is not a substitute for the full check.

Generated mutation views show duplicate owners/lost saves without the reservation, lost saves with an early snapshot, and foreign-record removal without the token guard. Rerun the checks for current reports rather than relying on deleted historical outputs.

## Bounds and remaining gaps

- Two canonical same-root starts on one host, each once with reuse enabled. Each caller can accept one distinct new path and have one pending body.
- Both participants follow the reviewed protocol, except the precisely mutated behavior in negative controls. Distinct tokens represent identities.
- Healthy loopback networking except an old owner can close during a probe. Participant PIDs remain alive after service close. Reservation contention can retry or time out without a liveness or fairness promise.
- Successful atomic workspace replacement, connection rename, and token-check cleanup actions. One bounded external foreign replacement occurs before close admission. No hostile filesystem change interleaves inside modeled cleanup.
- Reservation exclusion and lifetime are assumptions about the OS-held listener. The actual two-process replay exercises them on this host, not all kernels or operating systems.
- No crashes, power loss, partial writes, cross-host locking, network filesystems, hash collisions, unrelated reservation-port occupancy, concurrent legacy starters, unbounded restarts, deletions, existing-path edits, demo mode, child-process lifecycle, or notes/runs semantics. Startup maintenance placement is reviewed, not its content semantics.

Separate process, crash, and production-owner tests do not become formal coverage merely because they pass. This is exhaustive exploration of the named finite model, not an unbounded proof of TypeScript or filesystem safety.
