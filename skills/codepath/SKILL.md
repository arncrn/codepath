---
name: codepath
description: Create, update, or explain source walkthroughs using the Codepath VS Code extension. Use when the user invokes /codepath, asks to map a behavior or call flow, or wants a source-linked walkthrough or change review in Codepath rather than only a chat explanation.
compatibility: Requires the Codepath extension or browser service running for the target project. Use connected MCP tools, or Node.js 22.13+ (22.x) or 24+ with Codepath's bundled agent.mjs CLI.
---

# Codepath walkthroughs

Use the actual Codepath tools to deliver a walkthrough the user can open in VS Code, not just an explanation in chat. This skill supplies the workflow; it does not start a model or replace the extension's connection setup.

## 1. Identify the request and connect

Use the behavior, entry point, or walkthrough named by the user. If none is clear from the conversation, ask which behavior to map. Keep one walkthrough focused on one scenario. Do not change application code unless requested.

Prefer an already connected Codepath MCP server. Otherwise use the extension's CLI:

- Identify the folder opened in VS Code. It may be a subfolder of the Git repository. If several project roots are plausible, ask rather than writing to the wrong one.
- Use the actual `agent.mjs` and project paths from **Codepath → Connect your agent**. If the VS Code CLI is available, `code --locate-extension codepath-local.codepath-prototype` locates the extension; its bundled CLI is `dist/agent.mjs` inside that directory. As a fallback, inspect installed `codepath-local.codepath-prototype-*` directories in `~/.vscode/extensions`, `~/.vscode-insiders/extensions`, or the corresponding remote VS Code extension directory. Do not assume a version or use an unrelated installation when the active one is unclear.
- A source checkout's root `agent.mjs` can also be used after that checkout has been compiled. Do not install/build a checkout just to avoid using the installed extension.
- Check the selected project with `project_overview`. Confirm its returned `root` is the intended canonical folder before any write. If Codepath is not running, the connection is stale, or required capabilities are missing, ask the user to run **Codepath: Open Walkthroughs**, then reconnect/retry. Do not silently start a separate service, replace connection files, or fall back to editing saved JSON.
- Never print, copy into chat, or commit `.codepaths/connection.json` or its token. The bundled client handles local authentication.

CLI commands below use `CODEPATH_AGENT` for the actual agent filename and `PROJECT_ROOT` for the actual target folder. Set both to resolved paths first, and quote them:

```bash
node "$CODEPATH_AGENT" --root "$PROJECT_ROOT" --call project_overview
```

For MCP, read initialization instructions and tool schemas. For CLI-only agents, fetch the same current instructions and schemas through the bundled stdio adapter; this does not need an MCP integration in the agent harness:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node "$CODEPATH_AGENT" --root "$PROJECT_ROOT"
```

Follow those current instructions and inspect the relevant schemas before authoring. They are authoritative for field names, supported features, and source-bound checks; do not guess payloads from this skill. Call a tool through the CLI with:

```bash
node "$CODEPATH_AGENT" --root "$PROJECT_ROOT" --call TOOL_NAME --args '{"actual":"arguments from the current schema"}'
```

## 2. Read source and author the walkthrough

1. Read current source first. Use `inspect_source`, `read_source`, `search_source`, and `find_symbols` as appropriate. Continue every paged discovery/search through `nextCursor` until `complete` is true, including empty pages. An incomplete search proves neither uniqueness nor absence.
2. Trace the relevant behavior from its entry point through calls, callbacks, decisions, and important results. Establish connections from actual lexical/import/route/transport facts; a name match or neighboring card is not proof of a call. Mark uncertain connections `inferred` and explain what remains unknown.
3. For an existing walkthrough, call `get_walkthrough` first. Preserve stable card/note IDs, history, unrelated content, and user notes. Send the latest `expectedRevision` on guarded writes and re-read after every mutation. Handle conflicts by reading and reconciling, never overwriting from an old snapshot. Obtain explicit user confirmation before deletion.
4. Use `save_walkthrough` to save ordered cards with precise source references and concise purposes. Also author its Markdown `overview` main page: explain the big picture, key concepts/mental model, a concrete worked example, and important assumptions or caveats. Keep the short `description` separate. For overview-only changes, use `save_walkthrough_overview` with the latest revision instead of resending cards; never guess an overview from card titles alone. Use exact line ranges for callbacks, duplicate names, generics, or source shapes the approximate symbol index cannot navigate. Do not invent a function name from a card title; function labels come from source.
5. Complete all three explanation homes in this generation: **card purpose**, **source-attached block Notes**, and separate **named Variables** for relevant identifiers. Write plain-language explanations of what the code does and why it matters, not just types or a repetition of the purpose.
6. Use `add_reviewed_note` for new generated Notes/Variables and `review_note` for existing entries, with nonempty exact current source attachments. Variables also need `variableName` and whole-identifier occurrences of the correct binding, not unrelated or shadowed names. `add_note` is only for deliberate unanchored plain notes, not generated highlights or Variables.
7. Obtain current `code.hash`, `code.fileHash`, full-file lines, and revisions through `get_walkthrough`. Lines are one-based; columns are zero-based UTF-16 with an exclusive end. Attached text must match exactly. Re-review stale explanations deliberately; do not merely refresh hashes, discard notes, or archive content to pass a check. For genuinely inapplicable Notes/Variables, use explicit source-bound `notApplicable` reasons according to the current schema and disclose the exception.

## 3. Optional Flow and change review

- If the user asks for behavioral **Flow**, use `save_walkthrough_flow` after reading the source/cards. Author actual source-bound calls, decisions, joins, loops, or recursion independently of card order. Make opaque/dynamic connections explicitly unresolved. Flow does not replace card purposes, Notes, or Variables. Read back `flowState.status` as `current` and check that labels and true/false arrows match the actual conditions.
- For **Git/PR change review**, use `list_git_changes` and `get_git_file`, then `create_comparison_walkthrough` using the admitted list/file IDs and exact paired bindings. Read its schema; do not use ordinary current-source writes for historical sides. Explain each side independently with its own purpose, Notes, and Variables or justified N/A reasons. Do not substitute live files or caller-invented source for historical versions. Equal comparisons do not need invented cards. Read back the saved comparison and check its contents; ordinary `validate_walkthrough` is not a comparison-walkthrough validator.
- Do not fetch branches, mutate Git state, or mark files Viewed on the user's behalf. Static source is not observed execution; label hypothetical values as examples.

## 4. Verify, then hand off

For an ordinary generated walkthrough:

1. Call `get_walkthrough` and inspect the saved overview plus every card's source, purpose, Notes, and Variables. Check that the overview gives a useful mental model and a concrete example. Legacy/manual guides may lack an overview; include one for this generated guide. The validator below checks source-bound card content, not overview quality or completeness.
2. Call `validate_walkthrough` with its ID and the latest `expectedRevision`.
3. Fix reported issues and repeat readback/validation until `ready` is `true`. A save acknowledgement alone is not completion. Readiness checks source attachments, not semantic accuracy or coverage; review those yourself too.
4. If any request fails, times out, or remains unready, report the walkthrough as **incomplete**, with the blocker. Do not claim success or silently retry destructive work.

Hand off the walkthrough's exact title/ID, where to find it in Codepath, its validation result (or the comparison readback result), and any remaining uncertainty. Include one concrete card/file/line the user can open and what they should see, so they can verify the result without guessing.
