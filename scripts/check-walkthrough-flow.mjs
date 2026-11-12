import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  mainSource,
  helperSource,
  fixtureSteps,
  fixtureGraph,
} from "../tests/fixtures/semantic-flow.mjs";

// Shared actual Chrome / disposable native webview checks. Public service writes
// only; expected topology/attachments are manually worked from the real fixture.
export async function verifyWalkthroughFlow(service, getFrame, reopen) {
  let frame = await getFrame();
  await frame.locator('[data-step="a1"]').waitFor();
  await frame.locator("#flow-tab").click();
  await frame
    .getByText("Flow has not been authored for this walkthrough.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await frame.locator("#flow-panel svg").count(),
    0,
    "Legacy guide never falls back to invented reading-order flow"
  );
  fs.writeFileSync(path.join(service.root, "main.mjs"), mainSource);
  fs.writeFileSync(path.join(service.root, "helper.mjs"), helperSource);
  let walk = await service.call("save_walkthrough", {
    id: "semantic",
    title: "Actual source flow",
    steps: fixtureSteps,
  });
  for (const [stepId, line, variable] of [
    ["run", 3, "total"],
    ["helper", 2, "n"],
  ]) {
    for (const isVariable of [false, true]) {
      walk = await service.call("get_walkthrough", { id: walk.id });
      const code = walk.steps.find((s) => s.id === stepId).code;
      const text = isVariable ? variable : code.lines[line - 1];
      const startColumn = isVariable
        ? code.lines[line - 1].indexOf(variable)
        : 0;
      await service.call("add_reviewed_note", {
        walkthroughId: walk.id,
        stepId,
        expectedRevision: walk.revision,
        sourceHash: code.hash,
        fileHash: code.fileHash,
        author: "Fixture",
        body: isVariable
          ? "The local binding used by this calculation."
          : "This block participates in the selected control-flow explanation.",
        ...(isVariable ? { variableName: variable } : {}),
        attachments: [
          {
            file: code.file,
            fileHash: code.fileHash,
            startLine: line,
            endLine: line,
            startColumn,
            endColumn: startColumn + text.length,
            text,
          },
        ],
      });
    }
  }
  walk = await service.call("get_walkthrough", { id: walk.id });
  walk = await service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph: fixtureGraph(walk),
  });
  const run = await service.call("record_run", {
    walkthroughId: walk.id,
    label: "Flow example",
    mode: "example",
    origin: "Not observed execution",
    events: [
      { stepId: "run", output: { preserved: true } },
      { stepId: "helper", output: { preserved: true } },
    ],
  });
  await frame.locator("#refresh").click();
  await frame.locator('[data-path="semantic"]').click();
  await frame.locator("#flow-tab").click();
  await frame.locator("#flow-panel svg .node").first().waitFor();
  assert.equal(await frame.locator("#flow-panel svg .node").count(), 12);
  assert.equal(
    await frame.locator("#flow-panel svg .flowchart-link").count(),
    14
  );
  for (const id of ["s1", "s2", "s8"])
    assert.equal(
      await frame
        .locator(`#flow-panel svg .node[id*="-flowchart-${id}-"] polygon`)
        .count(),
      1,
      "Actual decisions use diamonds"
    );
  assert.match(await frame.locator("#flow-panel").innerText(), /recursion/);
  assert.match(await frame.locator("#flow-panel").innerText(), /loop/);
  assert.match(await frame.locator("#flow-panel").innerText(), /Unresolved/);
  assert.equal(
    await frame
      .locator("#flow-tab")
      .evaluate((node) => node === globalThis.document.activeElement),
    true,
    "Rendering does not steal keyboard focus"
  );
  assert.deepEqual(
    await frame.locator("#flow-panel svg .node").evaluateAll((nodes) =>
      nodes.flatMap((node, index) => {
        const shape = node
          .querySelector(".label-container")
          .getBoundingClientRect();
        const text = node.querySelector("text").getBoundingClientRect();
        return text.left >= shape.left - 1 &&
          text.right <= shape.right + 1 &&
          text.top >= shape.top - 1 &&
          text.bottom <= shape.bottom + 1
          ? []
          : [index];
      })
    ),
    [],
    "Actual diagram labels fit inside rendered shape bounds"
  );
  const observeCsp = () =>
    frame.evaluate(() => {
      globalThis.flowCspViolations = [];
      globalThis.document.addEventListener("securitypolicyviolation", (e) =>
        globalThis.flowCspViolations.push(
          e.violatedDirective + ": " + e.blockedURI
        )
      );
    });
  await observeCsp();
  async function exactFocus(node) {
    await frame
      .locator(`.code-card.active[data-step="${node.stepId}"]`)
      .waitFor();
    const card = frame.locator(".code-card.active");
    await card.locator("[data-flow-source]").first().waitFor();
    const selected = await card.locator("code[data-source-line]").evaluateAll(
      (lines, a) =>
        lines
          .filter(
            (line) =>
              Number(line.dataset.sourceLine) >= a.startLine &&
              Number(line.dataset.sourceLine) <= a.endLine
          )
          .map((line) =>
            [...line.querySelectorAll("[data-flow-source]")]
              .map((mark) => mark.textContent)
              .join("")
          )
          .join("\n"),
      node.attachment
    );
    assert.equal(
      selected,
      node.attachment.text,
      "Node reveals its exact UTF16 source selection, not the shared whole card"
    );
    assert.equal(
      await frame.locator(".code-card:not(.active) [data-flow-source]").count(),
      0
    );
    const mark = card.locator("[data-flow-source]").first();
    await frame.waitForFunction(() => {
      const el = globalThis.document.querySelector(
        ".code-card.active [data-flow-source]"
      );
      const r = el?.getBoundingClientRect();
      return (
        r &&
        r.y >= 0 &&
        r.y < globalThis.innerHeight &&
        r.x >= 0 &&
        r.x < globalThis.innerWidth
      );
    });
    assert.ok(await mark.isVisible());
  }
  const beforeFocus = await service.call("get_walkthrough", { id: walk.id });
  for (const [i, node] of walk.flow.nodes.entries()) {
    const button = frame.locator(
      `#flow-panel svg .node[id*="-flowchart-s${i}-"]`
    );
    if (i % 3 === 0) await button.click();
    else {
      await button.focus();
      await button.press(i % 3 === 1 ? "Enter" : "Space");
    }
    await exactFocus(node);
  }
  // Repeated same-card clicks must move focus; full-file toggles do not erase it.
  const first = frame.locator('#flow-panel svg .node[id*="-flowchart-s0-"]');
  await first.click();
  await exactFocus(walk.flow.nodes[0]);
  await frame.locator('.code-card.active [data-action="full"]').click();
  await exactFocus(walk.flow.nodes[0]);
  await frame.locator('.code-card.active [data-action="full"]').click();
  await exactFocus(walk.flow.nodes[0]);
  assert.deepEqual(
    await service.call("get_walkthrough", { id: walk.id }),
    beforeFocus,
    "Source focus and full-file toggles are read-only"
  );
  // Ordinary navigation retires the old focus, even when returning to the same ID.
  await frame.locator('[data-select="helper"]').click();
  assert.equal(await frame.locator("[data-flow-source]").count(), 0);
  await frame.locator('[data-select="run"]').click();
  assert.equal(await frame.locator("[data-flow-source]").count(), 0);
  // A delayed focus job must not scroll or revive after hiding the reader.
  await frame.evaluate(() => {
    const raf = globalThis.requestAnimationFrame;
    const calls = [];
    const scroll = globalThis.HTMLElement.prototype.scrollIntoView;
    globalThis.flowFocusScrolls = [];
    globalThis.HTMLElement.prototype.scrollIntoView = function (...args) {
      if (this.hasAttribute("data-flow-source"))
        globalThis.flowFocusScrolls.push(this.textContent);
      return scroll.apply(this, args);
    };
    globalThis.requestAnimationFrame = (cb) => {
      calls.push(cb);
      return 0;
    };
    globalThis.flushFlowFocus = () => {
      globalThis.requestAnimationFrame = raf;
      // Invoke even canceled callbacks to test the owner token, not cancellation alone.
      for (const cb of calls.reverse()) cb(performance.now());
      globalThis.HTMLElement.prototype.scrollIntoView = scroll;
    };
    globalThis.document
      .querySelector('#flow-panel svg .node[id*="-flowchart-s0-"]')
      .dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true }));
  });
  await frame.locator(".code-card.active [data-flow-source]").first().waitFor();
  await frame.evaluate(() =>
    globalThis.document.querySelector(".review-entry button").click()
  );
  await frame
    .locator(".walkthrough-surface[hidden]")
    .waitFor({ state: "attached" });
  await frame.evaluate(() => globalThis.flushFlowFocus());
  assert.deepEqual(await frame.evaluate(() => globalThis.flowFocusScrolls), []);
  assert.equal(await frame.locator("[data-flow-source]").count(), 0);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await first.click();
  await exactFocus(walk.flow.nodes[0]);
  await frame.locator("#data-tab").click();
  await frame.locator("#runs").selectOption(run.id);
  await frame.locator("#notes-tab").click();
  await frame.locator("#note-text").fill("Run-only unfinished draft");
  await frame.locator("#flow-tab").click();
  await frame
    .locator('#flow-panel svg [data-flow-step="helper"]')
    .first()
    .click();
  await frame.locator('.code-card.active[data-step="helper"]').waitFor();
  assert.equal(
    await frame.locator("#flow-tab").getAttribute("class"),
    "active"
  );
  await frame.locator("#notes-tab").click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "",
    "A draft cannot leak to B"
  );
  await frame.locator("#note-text").fill("Helper-only unfinished draft");
  await frame.locator("#flow-tab").click();
  const entry = frame.locator('#flow-panel svg [data-flow-step="run"]').first();
  await entry.focus();
  await entry.press("Enter");
  await frame.locator('.code-card.active[data-step="run"]').waitFor();
  await frame.locator('#flow-panel svg .node[id*="-flowchart-s1-"]').click();
  await exactFocus(walk.flow.nodes[1]);
  await frame.locator("#notes-tab").click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Run-only unfinished draft"
  );
  await frame.locator("#flow-tab").click();
  const helper = frame
    .locator('#flow-panel svg [data-flow-step="helper"]')
    .first();
  await helper.focus();
  await helper.press("Space");
  await frame.locator('.code-card.active[data-step="helper"]').waitFor();
  await frame.locator("#notes-tab").click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Helper-only unfinished draft"
  );
  if (!process.argv.includes("--desktop")) {
    let receive, release, finish;
    const received = new Promise((resolve) => {
      receive = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    let used = false;
    const handler = async (route) => {
      if (used || route.request().postDataJSON()?.name !== "add_note")
        return route.continue();
      used = true;
      const response = await route.fetch();
      receive();
      await held;
      await route.fulfill({ response });
      finish();
    };
    await frame.route("**/api/call", handler);
    await frame.locator("#note-form button").click();
    await received;
    await frame.locator("#flow-tab").click();
    await frame
      .locator('#flow-panel svg [data-flow-step="run"]')
      .first()
      .click();
    await frame.locator("#notes-tab").click();
    assert.equal(
      await frame.locator("#note-text").inputValue(),
      "Run-only unfinished draft"
    );
    await frame
      .locator("#note-text")
      .fill("Run newer draft while helper save waits");
    await frame.locator("#flow-tab").click();
    await frame
      .locator('#flow-panel svg [data-flow-step="helper"]')
      .first()
      .click();
    await frame.locator("#notes-tab").click();
    await frame
      .locator("#note-text")
      .fill("Helper newer draft while old save waits");
    release();
    await finished;
    await frame.unroute("**/api/call", handler);
    await frame
      .getByText("Helper-only unfinished draft", { exact: true })
      .waitFor();
    assert.equal(
      await frame.locator("#note-text").inputValue(),
      "Helper newer draft while old save waits"
    );
    await frame.locator("#flow-tab").click();
    await frame
      .locator('#flow-panel svg [data-flow-step="run"]')
      .first()
      .click();
    await frame.locator("#notes-tab").click();
    assert.equal(
      await frame.locator("#note-text").inputValue(),
      "Run newer draft while helper save waits"
    );
    const saved = await service.call("get_walkthrough", { id: walk.id });
    assert.ok(
      saved.steps
        .find((s) => s.id === "helper")
        .notes.some((n) => n.body === "Helper-only unfinished draft")
    );
    assert.ok(
      saved.steps
        .find((s) => s.id === "run")
        .notes.every((n) => n.body !== "Helper-only unfinished draft")
    );
    await frame.locator("#flow-tab").click();
    await frame
      .locator('#flow-panel svg [data-flow-step="helper"]')
      .first()
      .click();
  }
  await frame.locator("#variables-tab").click();
  await frame
    .locator("#variables-panel")
    .getByText("n", { exact: true })
    .waitFor();
  await frame.locator("#data-tab").click();
  assert.equal(await frame.locator("#runs").inputValue(), run.id);
  assert.match(await frame.locator("#values").innerText(), /preserved/);
  await frame.locator("#flow-tab").click();
  const before = await service.call("get_walkthrough", { id: walk.id });
  await delay(2300);
  assert.deepEqual(
    await service.call("get_walkthrough", { id: walk.id }),
    before,
    "Reading/polling/navigation never writes graph, source, notes or revision"
  );
  frame = await reopen();
  await frame.locator('.code-card.active[data-step="helper"]').waitFor();
  await frame.locator("#flow-panel svg .node").first().waitFor();
  assert.equal(
    await frame.locator("#flow-tab").getAttribute("class"),
    "active"
  );
  await observeCsp();

  const hostile = [
    'Alice & Bob #quot; " [ ] ( ) ` text',
    '<img src="https://invalid.test/x" onerror="alert(1)"><script>alert(2)</script>',
    '"]; evil[Injected]; click evil "https://invalid.test"; %%{init: {securityLevel: loose}}%%',
    "Unicode → café 日本語 😀 literal &lt; &#60; <br/>",
  ];
  walk = await service.call("get_walkthrough", { id: walk.id });
  const graph = structuredClone(walk.flow);
  hostile.forEach((label, i) => (graph.nodes[i].label = label));
  graph.edges[0].label = hostile[2];
  walk = await service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  await frame.locator("#refresh").click();
  await frame.waitForFunction(
    (label) =>
      globalThis.document
        .querySelector("#flow-panel svg")
        ?.textContent.replace(/\s/g, "")
        .includes(label.replace(/\s/g, "")),
    hostile[0]
  );
  for (const label of hostile)
    assert.ok(
      (await frame.locator("#flow-panel svg").textContent())
        .replace(/\s/g, "")
        .includes(label.replace(/\s/g, "")),
      "Hostile labels are literal text"
    );
  assert.equal(
    await frame
      .locator(
        "#flow-panel svg a, #flow-panel svg image, #flow-panel svg foreignObject, #flow-panel svg style, #flow-panel svg script, #flow-panel svg [style], #flow-panel svg [href]"
      )
      .count(),
    0
  );
  assert.deepEqual(
    await frame
      .locator("#flow-panel svg")
      .evaluate((svg) =>
        [...svg.querySelectorAll("*")].flatMap((n) =>
          [...n.attributes]
            .filter((a) => /^on/i.test(a.name))
            .map((a) => a.name)
        )
      ),
    []
  );
  const output = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR ?? ".cache/walkthrough-flow"
  );
  fs.mkdirSync(output, { recursive: true });
  await frame.locator("#flow-panel").screenshot({
    path: path.join(
      output,
      process.argv.includes("--desktop") ? "flow-native.png" : "flow-chrome.png"
    ),
  });
  await frame.getByRole("button", { name: "Fit diagram", exact: true }).click();
  const box = await frame.locator("#flow-panel svg").boundingBox();
  assert.ok(
    box.height <= 481,
    "Fit mode shows the whole graph in a bounded viewport"
  );
  await frame.getByRole("button", { name: "Actual size", exact: true }).click();
  const budget = structuredClone(graph);
  budget.summary =
    "Synthetic rendering-budget test only; duplicated source nodes are not execution occurrences or inferred connections.";
  for (let i = 12; i < 120; i++)
    budget.nodes.push({
      ...budget.nodes[0],
      id: "budget-" + i,
      kind: "process",
      label: "Budget node " + i,
    });
  walk = await service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph: budget,
  });
  await frame.locator("#refresh").click();
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelectorAll("#flow-panel svg .node").length ===
      120
  );
  assert.equal(
    await frame.locator("#flow-panel svg .flowchart-link").count(),
    14,
    "All authored edges retained at the node rendering budget"
  );
  walk = await service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  await frame.locator("#refresh").click();
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelectorAll("#flow-panel svg .node").length ===
      12
  );
  // Reordering does not create or alter a single semantic edge.
  walk = await service.call("save_walkthrough", {
    ...walk,
    expectedRevision: walk.revision,
    steps: [...walk.steps].reverse(),
  });
  assert.deepEqual(walk.flow, graph);
  await frame.locator("#refresh").click();
  await frame.locator("#flow-panel svg .node").first().waitFor();
  assert.equal(
    await frame.locator("#flow-panel svg .flowchart-link").count(),
    14
  );
  // Obsolete queued render cannot appear over an unauthored legacy guide.
  await frame.locator("#data-tab").click();
  await frame.evaluate(() => {
    const raf = globalThis.requestAnimationFrame;
    globalThis.restoreFlowRaf = () => (globalThis.requestAnimationFrame = raf);
    globalThis.requestAnimationFrame = (cb) =>
      raf((t) => setTimeout(() => cb(t), 350));
  });
  await frame.locator("#flow-tab").click();
  await frame.locator('#flow-panel [role="status"]').waitFor();
  await frame.locator('[data-path="b"]').click();
  await frame
    .getByText("Flow has not been authored for this walkthrough.", {
      exact: true,
    })
    .waitFor();
  await delay(700);
  assert.equal(await frame.locator("#flow-panel svg").count(), 0);
  await frame.evaluate(() => globalThis.restoreFlowRaf());
  // Also invalidate while the real library waits for browser text layout.
  await frame.evaluate(() => {
    const q = globalThis.queueMicrotask;
    globalThis.restoreFlowMicrotask = () => (globalThis.queueMicrotask = q);
    globalThis.queueMicrotask = (cb) => setTimeout(cb, 150);
  });
  await frame.locator('[data-path="semantic"]').click();
  await frame
    .locator('[id^="dwalkthrough-flow-"]')
    .waitFor({ state: "attached" });
  assert.equal(
    await frame
      .locator('[id^="dwalkthrough-flow-"]')
      .first()
      .evaluate((n) => globalThis.getComputedStyle(n).visibility),
    "hidden"
  );
  await frame.locator('[data-path="b"]').click();
  await frame.evaluate(() => globalThis.restoreFlowMicrotask());
  await delay(1000);
  assert.equal(await frame.locator("#flow-panel svg").count(), 0);
  await frame.locator('[data-path="semantic"]').click();
  await frame.locator("#flow-panel svg .node").first().waitFor();
  await frame
    .locator('#flow-panel svg [data-flow-step="helper"]')
    .first()
    .click();
  await frame.locator(".code-card.active [data-flow-source]").first().waitFor();
  fs.writeFileSync(
    path.join(service.root, "helper.mjs"),
    helperSource + "// changed outside selected function\n"
  );
  await frame.locator("#refresh").click();
  await frame
    .locator("#flow-panel")
    .getByText(/Flow source or linked cards changed/)
    .waitFor();
  assert.equal(
    await frame.locator("#flow-panel svg").count(),
    0,
    "Full-file change fails closed without auto relocation"
  );
  assert.equal(
    await frame.locator("[data-flow-source]").count(),
    0,
    "Stale source retires its highlight, not merely its diagram"
  );
  const stale = await service.call("get_walkthrough", { id: walk.id });
  assert.deepEqual(stale.flow, graph);
  fs.writeFileSync(path.join(service.root, "helper.mjs"), helperSource);
  await frame.locator("#refresh").click();
  await frame.locator("#flow-panel svg .node").first().waitFor();
  assert.equal(
    await frame.locator("[data-flow-source]").count(),
    0,
    "Restoring identical source does not revive a retired focus"
  );
  walk = await service.call("get_walkthrough", { id: walk.id });
  await service.call("save_walkthrough", {
    ...walk,
    expectedRevision: walk.revision,
    steps: [],
  });
  await frame.locator("#refresh").click();
  await frame
    .locator("#flow-panel")
    .getByText(/Flow source or linked cards changed/)
    .waitFor();
  assert.equal(await frame.locator("#flow-panel svg").count(), 0);
  walk = await service.call("get_walkthrough", { id: walk.id });
  await service.call("delete_walkthrough", {
    id: walk.id,
    expectedRevision: walk.revision,
  });
  await frame.locator("#refresh").click();
  await frame.locator('[data-step="a1"]').waitFor();
  assert.equal(await frame.locator("#flow-panel svg").count(), 0);
  assert.deepEqual(
    await frame.evaluate(() => globalThis.flowCspViolations),
    []
  );
  await frame.locator("#data-tab").click();
  console.log(
    "PASS semantic Flow: actual source branches/join/loop/imported call/recursion/unresolved; passive literal labels; exact source-block/UTF16 focus, same-card mouse/keyboard, guarded delayed scroll/hidden/stale lifetimes; per-card drafts, run, polling/context; stale/deleted sources; queued/in-flight render cancellation; no CSP violations."
  );
}
