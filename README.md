# Codepath prototype

A local source walkthrough tool for small JavaScript, TypeScript, React and Go projects. It lays out real source in an ordered row of code cards. Each walkthrough represents one behavior or scenario. Your existing coding agent can inspect the project, assemble paths, add notes and import data through MCP or the CLI.

This is a prototype, not a complete debugger. It runs inside VS Code as well as in a browser. Its MVP acceptance test is using Codepath to understand and comfortably review Codepath itself—not finishing every backlog feature. See TODO_LIST.md for outstanding work and the verification sections below for checks.

## Use in VS Code (recommended)

Install the local **codepath.vsix** file using **Extensions: Install from VSIX…** in VS Code, or from this directory:

    code --install-extension ./codepath.vsix

Requires desktop VS Code 1.99+ and a trusted, filesystem-backed workspace. The extension includes its runtime dependencies; you do not need npm, a separate Node install, a browser, or a manually started server to view walkthroughs.

1. Open your application folder and a source file.
2. Select code, then right-click **Codepath: Start Walkthrough from Selection**. With no selection, it starts at the cursor's line—not the containing function.
3. In a code card, right-click the specific identifier you want, then choose **Follow definition of …**. One definition is inserted immediately after that card; a choice is shown only for genuinely ambiguous definitions. Ctrl/Cmd-click or focus a token and press Enter to follow directly. Use **Add step** only for explicit connections such as an HTTP boundary.
4. Use **Open in editor ↗** on a card to return to the referenced source range. Notes, data and existing agent tools work in the same walkthrough.

Backend upgrades require **Developer: Reload Window** to load the new owner. When only the active panel assets are updated, save any draft and close/reopen the Codepath tab instead; the background service can keep running.

For example, start on either `HandleFunc` or `handleOrder` in `http.HandleFunc("/api/orders",handleOrder)`: the first card highlights that registration line. Right-click **handleOrder inside the card** to insert its definition, without filtering all calls in `main`. `HandleFunc` itself belongs to Go's standard library, outside the indexed project; it is not silently redirected to the callback.

Direct navigation first asks the installed VS Code language provider for a definition (so JS/TS aliases can work). If no provider result is available within five seconds, it uses a clearly **inferred** name match; Go fallback matches are restricted to the same directory/package. Multiple results require a choice, external/unindexed definitions aren't added, and source changes require refreshing the card. A resolved source definition is not proof that the function was invoked. This identifier-level navigation is currently VS Code-only.

Explanations have three levels:

- **Card description — high:** the whole function's purpose and the highlighted part's role.
- **Notes — medium:** how individual blocks and function calls work.
- **Variables — low:** named entries explaining what one variable represents and why it is used.

Notes add detail rather than duplicating the card summary. For code review, describe behavior before versus after at each relevant level. Navigation/setup history is not a code explanation. Confirmed connections need no “Source-linked” badge; an uncertain later-step connection has a plain-language warning. Example versus recorded data and changed-code warnings remain distinct.

### Correct, attach and follow explanations

Open **Notes** for block explanations or **Variables** for named variable explanations. Use **Edit** on an entry or **Edit card explanation** to correct its text. Save after reading the current source. Conflict checks run internally; a concurrent change preserves your draft and requires reviewing the latest saved text before continuing. Original IDs and previous versions remain stored, without reader-facing history panels.

Select a group of code lines and click **Create note**. The Notes editor opens with those whole lines already attached; write the note and **Save note**. The note and its blocks share an automatic color, with matching edge markers for overlapping blocks and line ranges beside the note. Existing current block attachments get colors too; stale, archived or unattached notes are never guessed onto code. Different selections keep independent drafts.

Use **Write variable explanation** for a named variable and attach its exact whole-name occurrences. Click an attached variable or press Space to reveal its entry in **Variables** without an automatic explanation popup. Enter still follows definitions in VS Code; Ctrl/Cmd-click and right-click remain available. Attachments retain exact UTF-16 coordinates and source checks. Changed source preserves the draft and needs explicit selection/review before retrying. Native type/IntelliSense support remains separate work, not inferred from authored descriptions.

Archived notes remain stored but are absent from the reading interface. Unclassified older notes stay in Notes until explicitly classified. Agent/API changes still preserve history and source/revision checks.

Use **Repair source reference** to replace missing or obsolete source. Confirmation uses the fingerprint of the source actually previewed. Source changes require another preview. Old explanations and notes remain independently unreviewed until corrected or deliberately re-reviewed.

Cards use local grammar coloring for JS, TS, JSX/TSX and Go. Source remains read-only. Reverse-reference lists and repeated-source occurrence controls are not part of the reading interface.

Cards no longer offer the **Callback role…** control. Existing role metadata is retained. A different visual structure for function calls and recursion is a separate design discussion.

**Codepath: Open Walkthroughs** and the **Codepath** status bar item reopen your folder's walkthroughs. In a multi-root workspace, the active source editor determines the folder; otherwise you choose one. Selected code is captured at line granularity. Codepath reads saved files and asks before saving a dirty file.

The extension starts its loopback service automatically on a free port. It keeps that service available for agents even after you close the panel, and stops services it owns when the VS Code window closes/reloads. An already-running healthy project service is reused, not stopped. Updated owners acquire a deterministic canonical-root loopback reservation before loading writable state and hold it through HTTP, handler and owned-backend drainage. Overlapping updated processes therefore share one writer. Failed probes reread connection metadata before considering liveness; unchanged live or unknown owners are not taken over. Port collisions fail closed rather than choosing another reservation. Healthy published legacy owners can be attached, but unmodified writers do not participate in this exclusivity protocol. Reload older owners before using the new tools. This is same-host protection, not a cross-host lock or power-loss durability guarantee. Webviews use VS Code messaging, not an iframe or direct localhost requests; the session token stays in the extension host.

Your last walkthrough, step and data/notes tab are remembered per workspace. In VS Code this survives panel close/reopen and window reload in the same workspace/profile. Browser restoration uses localStorage and requires the same origin (including service port) and profile. Deleted paths/steps fall back safely. A new agent focus request still takes precedence; an old already-consumed request does not steal your reading position. Draft note text and credentials are not persisted as reading context.

This removes server/folder/first-step setup, **not** the need to map a behavior. Codepath does not automatically infer a complete cross-layer path. Existing MCP/CLI agents still require the connection described below; there is no embedded model. Runtime values still require explicit capture. The bundled checkout is not automatically built or executed by the extension.

### Delete a walkthrough

Open the walkthrough and click **Delete walkthrough** beside **Add step**. Review its name and the counts of steps, notes and saved runs, then confirm. **Cancel**, Escape or closing the dialog leaves it unchanged.

Deletion permanently removes that walkthrough, its notes and its runs. There is no undo. Source files and other walkthroughs are never deleted. If a path edit, note or run arrives while the confirmation is open, deletion is rejected; choose **Review latest** and confirm again only after reviewing the updated details.

Deleting the last walkthrough returns to the empty workspace. Deleted demo walkthroughs are not automatically re-seeded on restart.

### Build or develop the extension

From this repository, with Node.js 22.13+ (22.x) or 24+ and npm:

    npm install
    npm run package:extension

This produces **codepath.vsix** locally; it does not publish anything. To develop, open this repository in VS Code and press **F5** using **Run Codepath Extension**. The launch task builds the extension first.

### Application stack and build

Codepath's service, indexer, persistence, MCP adapter and VS Code extension are authored in **strict TypeScript** (`.mts`). The shared browser/webview UI is **React + TypeScript**. `ui.tsx` only mounts `ui/App.tsx`, which composes the feature modules. Named operations such as `getWalkthrough` live in `ui/api.ts`, with transport plumbing in `ui/transport.ts`. UI actions call those named operations; protocol strings stay inside the interface/transport modules. `types.mts` defines the shared source, walkthrough, note, run and tool contracts. Runtime validation and the existing version-1 workspace format remain in place.

`npm run compile` uses the existing esbuild pipeline to emit Node ESM modules, the CommonJS extension bundle, and a local production React browser bundle into `dist/`. No TypeScript loader, CDN, new web framework or development server is required at runtime. The webview keeps its restricted messaging and nonce CSP. The VSIX allowlist ships only the extension, UI and agent runtime assets—not development/demo caches or workspace metadata.

`npm run typecheck` checks Node/extension and browser code separately; compiler regression tests assert invalid tool payloads and wrong-runtime globals are rejected. Native build/test scripts, compatibility launchers and the intentionally mixed-language sample retain JavaScript where appropriate. The sample's existing JSON instrumentation is not included in Codepath's strict typecheck.

`npm start`, `npm run demo:go` and `npm test` build first. Before calling `node server.mjs`, `node agent.mjs`, or importing `client.mjs` directly from a fresh source checkout, run `npm run compile`. These three small JavaScript compatibility entry points retain existing CLI/MCP/instrumentation paths; their application implementations are TypeScript.

### UI responsibilities

- `ui/reading-session.ts` owns loading, polling, reading position, focus restoration, and the selected run. Walkthrough and automatic-run requests share one request guard.
- `ui/walkthrough-commands.ts` owns revision-bearing create, append, reorder, remove, and delete operations. Deletion uses the snapshot the user reviewed.
- `ui/notes.tsx` owns the ordinary note draft and display. `ui/annotation-editor.tsx` and `ui/annotation-session.ts` own reviewed correction, attachment selection and reveal. Polling does not reset drafts.
- `ui/source-cards.tsx`, `ui/source-code.tsx`, and `ui/source-menu.tsx` own source display, expansion, scrolling, identifier gestures and previews. `ui/source-syntax.ts` owns pure grammar runs. `ui/callback-roles.tsx` owns explicit role editing.
- `ui/run-panel.tsx` owns data presentation and JSON import. `ui/dialogs.tsx` and `ui/source-picker.tsx` own their dialog and picker state.
- `ui/sidebar.tsx` and `ui/workspace-layout.tsx` render the application layout. They do not fetch or persist project data.

The transport, persisted reading-context shape, and workspace storage format are unchanged by the UI refactor. ESLint keeps the bootstrap small so feature logic does not accumulate there again.

## Learn Codepath using Codepath

Open this repository's **codepath-prototype** folder in VS Code and open Codepath. Start with **00 · Start here: how Codepath fits together**. Its eight cards explain the React UI, host/bridge, service, storage, indexer and external-agent adapter. The approved layout keeps overall purpose in the card, block explanations in Notes, and explicitly named individual explanations in Variables. All 78 cards across the seven walkthroughs now use that organization. Each has source-linked block Notes and named Variables; use the behavior walkthroughs when you want to follow a particular operation.

The 0.7.0 guide baseline retained all original IDs, 51 notes, prior history and 19 illustrative samples. Its technical checks did not establish usefulness; the user's review rejected the clutter and popup behavior. Version 0.7.1 implements the approved separation. The first card's accepted three Notes and eleven Variables are unchanged. At the user's request, the same organization is now published across every card, including twelve deliberately repaired source links. Duplicate glossaries are archived rather than deleted, and all original IDs, versions, samples and saved data are retained. The remaining hands-on acceptance is tracked in TODO_LIST.md. Historical setup/review commentary remains separately archived under `.codepaths/historical-review-findings.md`.

MVP acceptance still requires you to use these paths, understand the application and find the workflow comfortable. Automated checks do not establish that for you.

## Start the bundled browser example

Requirements: Node.js 22.13+ (22.x) or 24+ and npm. Go 1.22+ is optional.

From this directory:

    npm install
    npm start

Open the localhost URL printed in the terminal (normally http://127.0.0.1:4317).

1. Select **Submit an order · Node**.
2. Click **Try the example**.
3. Submit the default order. Wait until the receipt says **Run captured**.
4. Close the dialog. The run selector should switch to captured execution.
5. Follow the path with the numbered steps, horizontal scrolling, or the left/right arrow keys.
6. Compare the quantity string, JSON request, normalized email, discount, assigned ID and receipt text.
7. Try quantity 1 and then 2. SAVE10 applies only for two or more notebooks.
8. Add a note under a step. It survives restarts. Editing the referenced code marks the note for review.

The sample has 12 files, of which 11 are indexed JS/TS/Go source files. It includes a React/TypeScript frontend and equivalent Node and Go backend implementations. Orders live in memory and reset when the backend restarts. The UI has an example fixture before any run; that fixture is explicitly illustrative.

### Use the Go backend

Stop the Node example first, then:

    npm run demo:go

The server compiles the small Go app and forwards the example request to a loopback Go server. Select **Submit an order · Go**. The browser frontend is the same React source.

### Start from a test

Select **Reject an empty cart · test** to view its source path. Run the actual test locally with:

    node --test examples/checkout/api/service.test.mjs

The test path remains a source walkthrough; running this command alone does not automatically import an execution record. Use record_run for captured test events, as described below.

## Open your application

    npm start -- /absolute/path/to/your/app

Or:

    node server.mjs --root "/absolute/path/to/your/app" --port 4317

No GitHub connection is used. Source is read from the local folder; only .codepaths metadata is written into it. The prototype does not execute or build arbitrary user application code. The bundled example is the only app the server executes automatically.

Create a walkthrough, give it a behavior name, then choose its first symbol or file range. In VS Code, follow a specific identifier directly from the card. **Add step** appends a chosen source range for explicit connections, such as a frontend request to a backend route. There is no whole-function call browser in the UI. Agents can still use `follow_calls` to discover name-matched candidates; these are not resolved imports or execution evidence. Cards can be moved or removed without changing source. A later return to the same file/function can be a separate card with a different step ID.

Use exact line ranges for JSX buttons, anonymous callbacks, duplicate function names, or unsupported symbol shapes. Text search helps find a route or string across eligible project files. Discovery and searches are paged; continue with **More files** or **More results** rather than treating the first page as the entire repository.

The scanner skips dot directories, symlinks, node_modules, vendor, dist, build, coverage and out. For extra exclusions create .codepaths-ignore in your app with one relative file/directory prefix per line. It is not full gitignore syntax.

There is no repository-wide 200-file or 5,000-entry cutoff. Discovery advances in small request-driven chunks without reading source contents; a known eligible filename can be opened immediately, even before discovery reaches it. Source is parsed on demand and unchanged results are reused in an evictable cache (128 files and 16 MiB of estimated source/symbol data by default). Cache eviction does not make a file unavailable. The 1 MiB per-source-file bound remains.

`project_overview` returns lightweight discovery progress and at most 100 filenames, **not** an exhaustive symbol index. Use `list_source_files`, `find_symbols` or `search_source`, following `nextCursor` until `complete` is true, including empty pages. `inspect_source` loads one file's symbols, line count and fingerprint. Candidate searches (`follow_calls`/`resolve_reference`) also expose continuation; partial results do not establish uniqueness or absence. Cursors are query-bound, expire after five minutes, and must be restarted if evicted or exclusions change. Native VS Code definitions load eligible targets directly instead of first scanning fallback candidates throughout the repository.

This removes a coverage restriction, not every scaling bottleneck: cards still carry full-file source, walkthrough metadata is still saved as one JSON record, and the target real-world monorepo on another machine has not been benchmarked. Walkthrough archiving and automatic main-integration/PR generation are separate, unimplemented features.

## Connect a coding agent

Open Codepath in VS Code, or keep the browser server running for the project. Click **Connect your agent** in the UI for a config containing your actual local paths. The installed extension includes its own `agent.mjs`; a stdio MCP client still needs a Node.js 22+ executable to launch it.

Generic stdio MCP configuration:

    {
      "mcpServers": {
        "codepath": {
          "command": "node",
          "args": [
            "/absolute/path/codepath-prototype/agent.mjs",
            "--root",
            "/absolute/path/to/your/app"
          ]
        }
      }
    }

Merge the server entry into your client's existing configuration; do not replace unrelated server entries. Client configuration locations vary.

The MCP server supports initialize, ping, tools/list and tools/call. It negotiates protocol versions 2024-11-05, 2025-03-26 or 2025-06-18. It exposes 18 tools. This is a minimal adapter, not a full MCP SDK implementation.

- project_overview, read_source, search_source, follow_calls, resolve_reference
- get_walkthrough, save_walkthrough, delete_walkthrough, source_usages
- add_note, add_reviewed_note, review_note, review_explanation, repair_step_source, focus_step
- list_runs, get_run, record_run

For an existing walkthrough, read it and send its revision as expectedRevision when saving or deleting. Path edits, notes and new runs advance that revision. This prevents an outdated update or deletion from discarding newer agent/user work. A stale save cannot resurrect a deleted walkthrough. Notes attach to stable step IDs and the selected source fingerprint. Agents must obtain explicit user confirmation before calling the destructive `delete_walkthrough` tool.

Suggested prompt:

> Use Codepath to map what happens when a user clicks Submit. Read the source first. Include the component, handler, request, backend route, service, repository and response/render path. Explain what each highlighted range does: inputs, results, conditions and state changes. Keep setup history and separate review findings out of code explanations. For code review, explain behavior before versus after. Mark uncertain connections inferred. Do not claim execution without recorded events. Use example mode for invented sample data.

### CLI fallback

    node agent.mjs --root "/absolute/project" --call project_overview
    node agent.mjs --root "/absolute/project" --call search_source --args '{"query":"submit"}'
    node agent.mjs --root "/absolute/project" --call get_walkthrough --args '{"id":"PATH_ID"}'

A real agent can also use this CLI. No AI model or paid API is built into the prototype.

## Data capture

The prototype does not infer runtime values. It stores explicitly supplied snapshots.

The bundled checkout is instrumented at seven selected checkpoints. Its capture is real execution, but it is not a complete line trace, general time-travel recording, or proof that no other code ran. Failed checkout requests currently display an error without saving a full failed run.

For your own app, collect plain JSON values at useful boundaries and submit a run with record_run. JS callers can import callTool from client.mjs after building; the implementation is client.mts and the emitted module is dist/client.mjs; other languages can post the same JSON to the local API, or write a run JSON file and import it through the UI. Keep calls out of production unless you deliberately integrate them.

Example run payload:

    {
      "walkthroughId": "PATH_ID",
      "label": "Valid submit",
      "mode": "recorded",
      "origin": "Values captured by explicit test instrumentation",
      "events": [
        {
          "stepId": "submit",
          "input": {"quantity": "2"},
          "output": {"quantity": 2}
        },
        {
          "stepId": "save",
          "input": {"total": 2160},
          "output": {"id": "order-001", "total": 2160}
        }
      ]
    }

Set mode to example for hypothetical/AI-generated data. UI imports bind the payload to the currently selected walkthrough. Every event must reference an existing step ID. The latest 50 runs are retained, up to 200 events and 1 MiB per run.

Optionally include sourceHash on an event if you know the exact source file version that executed. read_source returns fileHash. Do not label an old process's execution with the hash of newly edited source. Without a hash, the UI states that the source revision is unknown. The example stamps hashes from its build/server session.

record_run accepts reported provenance; it does not cryptographically verify a caller's execution claim. Snapshots show selected values at boundaries, not complete variable histories. Multiple events for one step are retained; the UI currently shows the last, with a count.

## Local storage

Paths, notes, fixture values and runs are saved in:

    YOUR_APP/.codepaths/workspace.json

The running server's port and session token are in:

    YOUR_APP/.codepaths/connection.json

The entire `.codepaths/` directory is ignored by default, including connection credentials and local walkthroughs/notes. The existing own-source learning guide is therefore local data, not included in a fresh Git clone. You may export or version sanitized walkthrough data intentionally, but inspect captured values first; no automatic redaction is implemented.

Use the UI/API for writes while the server runs. Hand-editing workspace.json during a running session is unsupported because the service owns an in-memory copy. Stop the server first. Source edits are picked up by the browser's two-second refresh.

The local Codepath-on-Codepath learning-guide update preserves old note bodies/authors/timestamps/hashes in note history and a separate historical archive. Its explicit `pending-note-updates.json` maintenance request is applied only when a new service owns the folder—not by an attached host or by editing a running owner's workspace.json. All replacements are checked against the old note and reviewed current excerpt before any are saved; a mismatch leaves them pending and reports a warning. The batch is atomic and idempotent. This maintenance path is separate from the general correction UI. Neither performs automatic semantic reverification.

The HTTP server binds to loopback, validates Host/Origin, requires a local session token for API operations, bounds request size and restricts source reads to eligible project files regardless of discovery progress or cache residency. It is a local development prototype, not a multiuser server.

## Current boundaries

- JS/TS/React: TypeScript syntax parsing, not full TypeScript type-resolution or runtime call analysis.
- Go: approximate function and method indexing with lexical masking; generic signatures, unusual return types and complex constructs need manual range selection.
- Calls: agent-only `follow_calls` uses name matches. Direct identifier navigation in VS Code prefers language definitions, with an inferred name fallback. Provider availability, source exclusions and per-file limits still apply; this is not automatic callback execution, virtual dispatch or HTTP/queue tracing.
- Layout: one ordered path; alternative branches should be separate walkthroughs for now.
- Cross-layer paths: the sample is explicitly mapped. No promise of automatic whole-app tracing.
- Notes and explanations: persistent explicit correction/re-review, history and displayed-code attachments. No automatic AI rewriting, native-editor explanation hover or Git revision history.
- Values: explicit instrumentation or fixture import; no arbitrary local-variable capture.
- UI: read-only code cards in VS Code or a browser. Source editing stays in your editor. The VS Code extension supports trusted filesystem folders, not vscode.dev or virtual workspaces; remote hosts have not been verified.
- Agent: existing local MCP/CLI-capable agent required. Codepath has no embedded LLM.

## Linting, formatting and commit hooks

Development tooling requires Node.js 22.13+ (22.x) or 24+. Run `npm install` to install dependencies and configure Husky.

    npm run typecheck     # Strict TypeScript checks for Codepath's Node/host and React UI
    npm run lint          # ESLint for JS/JSX and TS/TSX, including the sample
    npm run lint:fix      # Apply available ESLint fixes
    npm run format:check  # Check Prettier formatting without changing files
    npm run format        # Format supported source/docs with Prettier
    npm run lint:go       # go vet for the Go example (requires Go)
    npm run format:go     # gofmt for the Go example (requires Go)

ESLint uses recommended JavaScript and TypeScript rules with separate Node/browser globals. The demo's untyped JSON capture snapshots are intentionally exempt from the explicit-any rule. ESLint is distinct from TypeScript checking; `npm run typecheck` now checks Codepath's application modules and shared React UI. Minimatch overrides keep the lint-tool dependency trees on a patched version.

VS Code settings enable format-on-save using the recommended Prettier extension; ESLint and Go extension recommendations are included. Generated bundles, dependencies, local caches, `.codepaths` metadata and lockfiles are excluded from formatting. Formatter setup did **not** mass-format the existing code. The migrated TypeScript/React files are formatted; `format:check` can still report pre-existing unformatted files until you choose to normalize them. Formatting source can mark source-linked annotations stale.

The Husky pre-commit hook runs lint-staged, `npm run typecheck`, then `npm test`. Staged JS/TS is linted and formatted, staged Go is formatted with gofmt, and other supported staged files use Prettier. Go is needed only when Go files are staged or its optional checks are invoked. Type checking is included with the TypeScript migration. Desktop/browser integration tests remain explicit commands, not commit-time checks.

This checkout's Git root is the parent directory, so `prepare` installs hooks at `codepath-prototype/.husky/_`; the hook enters the package directory before running npm. If you move the package to a different repository layout, adjust that prepare path. Files outside this package are not processed by its lint-staged configuration. The first commit may format many files if they are all staged. Setup does not stage changes or create a commit for you.

Hook verification used a disposable repository: a passing commit formatted staged JS/Go and ran all tests, partially staged work and sibling files were preserved, and lint/typecheck/test failures blocked commits. A fully formatted disposable copy also passed the VS Code integration test. The real project's staged snapshot was left untouched.

## Repository hygiene

Keep source, tests, lockfiles, examples, project docs and the maintained formal models/scripts in Git. Ignore dependencies (`node_modules/`), builds (`dist/`, `*.vsix`), local state/credentials (`.codepaths/`, `.env*`), diagnostics (`.cache/`, `.agent-output/`, logs) and generated formal reports/charts. Sanitized `.env.example` files remain publishable. Local agent handoff and historical assessment reports are also excluded.

The application `.gitignore` protects a standalone checkout. If this folder is nested in a larger Git checkout, also protect any parent-level local state in that checkout's root ignore file; use `git rev-parse --show-toplevel` to check the actual scope. Ignoring a file does not untrack an already committed copy: review `git status` and `git diff --cached --name-only` before committing. Cleanup does not stage, commit or push anything.

Generated diagnostics can be removed and recreated by tests/verification. Keep local build assets while a service uses them; they stay ignored. The standard formal checks regenerate their own tool cache and reports as needed.

## Formal verification

The project-local `/verify-service-ownership` skill checks local-service ownership and accepted-save preservation using a bounded TLA+ model plus real-source HTTP/filesystem replay. See `formal/service-ownership/README.md` in the source checkout for the model, scope and findings.

    npm run verify:formal
    npm run verify:formal:mutation

Requires Java 11+; the first run downloads checksum-pinned TLA+ tools 1.7.4. The updated main check passes all three invariants in 893 finite states and actual-source HTTP/filesystem replays. The mutation check separately catches missing reservation, premature workspace loading and removed token cleanup guards. Mutation success is verifier sensitivity, not a product-safety verdict by itself. The model bounds two same-root callers to one new-path save each. It does not prove OS exclusion, crash or power-loss safety, arbitrary content updates, cross-host locking or unbounded concurrency. Separate real process, crash and shutdown tests support the implementation outside that finite model.

## Verify locally

    npm run typecheck
    npm run lint
    npm test
    npm run test:browser
    npm run test:ui-refactor
    npm run test:learning-features
    npm run test:reading-context
    npm run test:reading-context:vscode

`test:source-project` exercises actual Chrome against a fixture with 311 source files and 5,100 asset entries, including late-file discovery/selection and cancellation of a delayed picker lookup. Ordinary tests cover on-demand reads, cache reuse/eviction, changed/deleted/ignored files, exact source-review guards, paged searches and native targets outside discovery. These are bounded synthetic regressions, not a benchmark of the user's remote monorepo.

`test:learning-features` runs actual-Chrome correction/attachment, Variables, minimal-reading-UI, colored block-note creation, grammar, callback-control removal and dialog-race suites serially. `test:source-usages` checks the retained read-only backend query, not a reader-facing panel. It covers exact range/version checks, history, stale preview rejection, partial-identifier attachment composition, late navigation, and newer drafts surviving old dialog replies. `npm run test:service:go` adds optional real-Go shutdown and failed-signal checks. Feature screenshots default to ignored `.cache/` directories; `CODEPATH_TEST_OUTPUT_DIR` can redirect them.

The UI refactor regression suite uses the real service with held responses. It covers old walkthrough, run, and overview replies arriving after newer navigation; drafts during polling and delayed saves; explicit same-step resets; dialog-deferred focus; manual run selection; and revision-safe deletion with an outstanding read.

The focused reading-context checks cover reload/reopen, workspace isolation, old versus new agent focus, deleted state, and keeping drafts/private data out of stored UI position. The `:vscode` variant uses the actual desktop editor with a disposable short profile path, not the user's profile.

The committed browser integration uses headless Chrome (`playwright-core`, with Chrome installed; `CHROME_CHANNEL` can choose another installed channel). It exercises the real seven-checkpoint checkout capture for quantities 1 and 2, React create/source-picker forms, escaped source/text, full-file and range views, note persistence/staleness, concurrent notes and drafts while polling, a deliberately delayed note-save response, reorder/remove, keyboard navigation, JSON import, narrow layout and reload persistence. All test workspaces are disposable. To exercise the same browser capture checks with the real Go backend, run `CODEPATH_BROWSER_BACKEND=go npm run test:browser` (requires Go).

The suite includes real HTTP service lifecycle, reuse, agent CLI writes, compatibility entry points, VSIX release-asset exclusion, access guards and webview protocol checks, in addition to the workspace and sample-service tests. Deletion tests cover cascading notes/runs, revision conflicts, persistence failures, stale-save rejection, source preservation and keeping an intentionally emptied demo empty after a real service restart.

To test in an isolated VS Code window (does not use your profile or installed extensions):

    npm run test:vscode

This requires a desktop session and an installed VS Code executable. macOS application paths are detected; set `VSCODE_EXECUTABLE` to the application executable on other setups. It exercises the actual extension host and rendered webview through Playwright/CDP: line-based cursor/selection starts, notes, absence of the old call-browser control, explicit Add step filtering, actual TS alias definition lookup, right-click navigation from the Go sample's `HandleFunc` registration to `handleOrder` (without a Go extension), source navigation, deletion cancellation/conflicts/cascade, recovery from another client's deletion, empty-state reopening and cleanup. Only the test window exposes a temporary Chromium debugging port. `CODEPATH_TEST_EXTENSION_DIR` can point to an unpacked VSIX's `extension/` directory to test the shipped bundle without `node_modules`.

Local unit/HTTP and VS Code integration have been run successfully on macOS, including the unpacked VSIX without `node_modules`. A headless Chrome smoke check also verified all three demo paths resolve and the Node checkout records seven source-hashed checkpoints with matching receipts/discounts for quantities 1 and 2. The committed browser integration also passes with the real Go backend, capturing all seven checkpoints for quantities 1 and 2. Commercial MCP-client interoperability remains unverified. Neither the VSIX nor the source has been published.
