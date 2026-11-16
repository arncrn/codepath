/* global window, document, getComputedStyle, innerWidth, innerHeight -- Owned browser/native fixture callbacks. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { authorReviewFlow } from "./review-flow-check.mjs";

async function until(read, message) {
  const deadline = Date.now() + 12000;
  while (!(await read())) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}
// Hold a real response, unchanged on release, through either public transport.
// Native puts a test gate ahead of the exact original message callback in the
// owned host; no replacement API/connection or fabricated successful payload.
export async function holdRefreshRead(frame, name) {
  const native = await frame.evaluate(
    () => window.CODEPATH_CONFIG.host === "vscode"
  );
  if (native) {
    await frame.evaluate((name) => {
      const test = { held: false, data: null, listener: null };
      test.listener = (event) => {
        const d = event.data,
          r = d?.result;
        const matches =
          name === "project_overview"
            ? r?.index && Array.isArray(r.paths)
            : name === "list_git_changes"
              ? Array.isArray(r?.files) && typeof r.listId === "string"
              : r?.binding && r?.file && r?.before && r?.after;
        if (!test.held && d?.type === "codepath.response" && matches) {
          test.held = true;
          test.data = d;
          event.stopImmediatePropagation();
        }
      };
      window.__refreshHold = test;
    }, name);
    // At Window, a later capture listener alone cannot precede the existing
    // at-target transport listener. Re-register that exact original callback
    // AFTER the test gate; its implementation and response bytes stay intact.
    let cdp;
    for (let target = frame; target; target = target.parentFrame()) {
      try {
        cdp = await frame.page().context().newCDPSession(target);
        break;
      } catch (error) {
        if (!error.message.includes("part of the parent frame")) throw error;
      }
    }
    assert.ok(cdp, "Owned native reader ancestor must have a CDP target");
    try {
      const contexts = [];
      cdp.on("Runtime.executionContextCreated", (event) =>
        contexts.push(event.context)
      );
      await cdp.send("Runtime.enable");
      let contextId;
      for (const context of contexts) {
        const check = await cdp.send("Runtime.evaluate", {
          contextId: context.id,
          expression:
            'typeof window.CODEPATH_CONFIG !== "undefined" && !!document.getElementById("refresh")',
          returnByValue: true,
        });
        if (check.result.value === true) {
          contextId = context.id;
          break;
        }
      }
      assert.ok(
        contextId,
        "Owned native reader execution context must be identified"
      );
      const object = (
        await cdp.send("Runtime.evaluate", {
          contextId,
          expression: "window",
          objectGroup: "refresh-fixture",
        })
      ).result.objectId;
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: object,
      });
      let handler;
      for (const listener of listeners.filter((l) => l.type === "message")) {
        const candidate =
          listener.originalHandler?.objectId ?? listener.handler?.objectId;
        if (!candidate) continue;
        const source = await cdp.send("Runtime.callFunctionOn", {
          objectId: candidate,
          functionDeclaration:
            "function(){return Function.prototype.toString.call(this);}",
          returnByValue: true,
        });
        if (source.result.value?.includes("codepath.response")) {
          handler = candidate;
          break;
        }
      }
      assert.ok(
        handler,
        "Actual native transport response listener must be identified: " +
          JSON.stringify(
            listeners.map((l) => ({
              type: l.type,
              keys: Object.keys(l),
              handler: l.handler?.description,
              original: l.originalHandler?.description,
            }))
          )
      );
      await cdp.send("Runtime.callFunctionOn", {
        objectId: handler,
        functionDeclaration:
          'function(){window.removeEventListener("message",this);window.addEventListener("message",window.__refreshHold.listener);window.addEventListener("message",this);}',
        returnByValue: true,
      });
    } finally {
      await cdp.send("Runtime.releaseObjectGroup", {
        objectGroup: "refresh-fixture",
      });
      await cdp.detach();
    }
    return {
      wait: () =>
        until(
          () => frame.evaluate(() => !!window.__refreshHold?.held),
          "Native response was not captured"
        ),
      release: async (error) =>
        frame.evaluate((error) => {
          const t = window.__refreshHold;
          if (!t) return;
          window.removeEventListener("message", t.listener);
          delete window.__refreshHold;
          if (t.data)
            window.dispatchEvent(
              new MessageEvent("message", {
                data: error ? { ...t.data, result: undefined, error } : t.data,
              })
            );
        }, error),
    };
  }
  let held = false,
    notify,
    release,
    drained;
  const ready = new Promise((r) => (notify = r)),
    gate = new Promise((r) => (release = r)),
    done = new Promise((r) => (drained = r));
  let failure;
  const route = async (r) => {
    if (!held && r.request().postDataJSON().name === name) {
      held = true;
      try {
        const response = await r.fetch();
        notify();
        await gate;
        if (failure) await r.fulfill({ status: 503, json: { error: failure } });
        else await r.fulfill({ response });
      } finally {
        drained();
      }
    } else await r.continue();
  };
  await frame.route("**/api/call", route);
  return {
    wait: () => ready,
    release: async (error) => {
      failure = error;
      release();
      if (held) await done;
      await frame.unroute("**/api/call", route);
    },
  };
}
async function settled(frame) {
  await until(
    async () =>
      (await frame.locator(".refresh-status").textContent()) === "Refreshed",
    "Current view did not finish refreshing"
  );
  assert.equal(await frame.locator("#refresh").isDisabled(), false);
  assert.equal(
    await frame.locator("#refresh").getAttribute("aria-busy"),
    "false"
  );
}
async function busy(frame) {
  assert.equal(
    await frame.locator("#refresh").isDisabled(),
    true,
    JSON.stringify(
      await frame.evaluate(() => ({
        button: document.getElementById("refresh")?.outerHTML,
        status: document.querySelector(".refresh-status")?.textContent,
        title: document.getElementById("title")?.textContent,
        held: window.__refreshHold?.held,
        focus: window.__refreshHold?.data?.result?.focus,
      }))
    )
  );
  assert.equal(
    await frame.locator("#refresh").getAttribute("aria-busy"),
    "true"
  );
  assert.match(await frame.locator("#refresh").textContent(), /Refreshing/);
  assert.equal(
    await frame.locator(".refresh-status").textContent(),
    "Refreshing…"
  );
  const clipped = await frame.locator(".refresh-status").evaluate((n) => {
    const b = n.getBoundingClientRect();
    return (
      b.width > 0 &&
      b.height > 0 &&
      b.left >= 0 &&
      b.top >= 0 &&
      b.right <= innerWidth &&
      b.bottom <= innerHeight &&
      getComputedStyle(n).visibility === "visible"
    );
  });
  assert.equal(clipped, true, "Feedback must really fit the viewport");
}
export async function verifyRefresh(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
    ? await frame.locator("[data-path].selected").getAttribute("data-path")
    : null;
  const previousStep = (await frame.locator(".code-card.active").count())
    ? await frame.locator(".code-card.active").getAttribute("data-step")
    : null;
  const makeWalk = (id, file, title) =>
    f.service.call("save_walkthrough", {
      id,
      title,
      steps: [
        {
          id: "reader",
          title: "Read the saved amount",
          source: { file, startLine: 1, endLine: 1 },
          explanation: "Use the saved amount.",
        },
      ],
    });
  f.write("refresh-reader.ts", "export const amount = 1;\n");
  const walk = await makeWalk(
    "refresh-reader",
    "refresh-reader.ts",
    "Refresh reader"
  );
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  if (
    await frame
      .getByRole("button", { name: "Back to walkthrough", exact: true })
      .isVisible()
  )
    await frame
      .getByRole("button", { name: "Back to walkthrough", exact: true })
      .click();
  await frame
    .locator(".code-card.active")
    .filter({ hasText: "export const amount = 1;" })
    .waitFor();
  await frame.locator("#notes-tab").click();
  await frame.locator("#note-text").fill("Independent unsaved refresh draft");
  let hold = await holdRefreshRead(frame, "project_overview");
  try {
    f.write("refresh-reader.ts", "export const amount = 7;\n");
    await frame.locator("#refresh").click();
    await hold.wait();
    await busy(frame);
  } finally {
    await hold.release();
  }
  await settled(frame);
  await frame
    .locator(".code-card.active")
    .filter({ hasText: "export const amount = 7;" })
    .waitFor();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Independent unsaved refresh draft"
  );
  assert.equal(
    (await f.service.call("get_walkthrough", { id: walk.id })).revision,
    walk.revision
  );

  // An automatic response is captured BEFORE a newer workspace revision.
  hold = await holdRefreshRead(frame, "project_overview");
  try {
    await hold.wait();
    await makeWalk(
      "refresh-created-during-poll",
      "refresh-reader.ts",
      "Created during a running refresh"
    );
    await frame.locator("#refresh").click();
    await busy(frame);
  } finally {
    await hold.release();
  }
  await settled(frame);
  await frame.locator('[data-path="refresh-created-during-poll"]').waitFor();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Independent unsaved refresh draft"
  );

  hold = await holdRefreshRead(frame, "project_overview");
  try {
    await frame.locator("#refresh").click();
    await hold.wait();
    await busy(frame);
  } finally {
    await hold.release("Fixture refresh unavailable");
  }
  await until(
    async () =>
      /Refresh failed:.*Fixture refresh unavailable/.test(
        await frame.locator(".refresh-status").textContent()
      ),
    "Failure must not be reported as Refreshed"
  );
  assert.equal(await frame.locator("#refresh").isDisabled(), false);
  await frame.locator("#refresh").click();
  await settled(frame);
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Independent unsaved refresh draft"
  );

  const flow = await authorReviewFlow(f, {
    file: "refresh-flow.ts",
    branch: "refresh-flow-base",
  });
  await frame.locator(`[data-path="${flow.walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${flow.walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame
    .locator("#note-text")
    .fill("Flow owner draft survives review refresh");
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const review = frame.locator("#current-changes");
  await review.getByRole("button", { name: "Changes", exact: true }).click();
  await review.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await review
    .getByRole("button", { name: "Open unstaged refresh-flow.ts", exact: true })
    .click();
  await review
    .locator('[data-review-path="refresh-flow.ts"] [data-source-state=ready]')
    .waitFor();
  const viewed = review.locator(
    '[data-review-path="refresh-flow.ts"] input[type=checkbox]'
  );
  if (!(await viewed.isChecked())) await viewed.click();
  await until(() => viewed.isChecked(), "Manual Viewed was not set");
  await frame.getByRole("button", { name: "Flow", exact: true }).click();
  await frame.locator("[data-flow-after-state=ready]").waitFor();
  await frame.locator("#review-flow-panel [data-flow-node=s0]").waitFor();
  const originalGraph = (
    await f.service.call("get_walkthrough", { id: flow.walk.id })
  ).flow;
  assert.equal(originalGraph.nodes.length, 2);
  f.write("refresh-visible.ts", "export const refreshed = true;\n");
  hold = await holdRefreshRead(frame, "list_git_changes");
  try {
    await frame.locator("#refresh").click();
    await hold.wait();
    await busy(frame);
  } finally {
    await hold.release();
  }
  await settled(frame);
  await review
    .getByRole("button", {
      name: "Open untracked refresh-visible.ts",
      exact: true,
    })
    .waitFor();
  await frame.locator("[data-flow-after-state=ready]").waitFor();
  assert.equal(
    await viewed.isChecked(),
    true,
    "Only the same exact source pair recovers Viewed"
  );
  assert.equal(
    await frame
      .locator("#review-flow-panel [data-flow-node=s0]")
      .getAttribute("data-flow-change"),
    "unchanged"
  );
  assert.deepEqual(
    (await f.service.call("get_walkthrough", { id: flow.walk.id })).flow,
    originalGraph
  );

  // Query A→B→A must not revive an older completion/error, even with equal bytes.
  hold = await holdRefreshRead(frame, "list_git_changes");
  try {
    await frame.locator("#refresh").click();
    await hold.wait();
    await busy(frame);
    await review.getByRole("button", { name: "Compare", exact: true }).click();
    await review.locator(".git-file-list[data-inventory-ready=true]").waitFor();
    await review.getByRole("button", { name: "Changes", exact: true }).click();
    await review.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  } finally {
    await hold.release("Retired comparison failure");
  }
  assert.equal(
    await frame.locator(".refresh-status").textContent(),
    "",
    "Retired failure/finally must not update the restored view"
  );
  assert.equal(await frame.locator("#refresh").isDisabled(), false);
  await review
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await settled(frame);
  await frame.locator("[data-flow-after-state=ready]").waitFor();
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await frame.locator("#notes-tab").click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Flow owner draft survives review refresh"
  );
  if (previousPath) {
    const previous = frame.locator(`[data-path="${previousPath}"]`);
    if (await previous.isVisible()) await previous.click();
    else await previous.evaluate((n) => n.click());
    if (previousStep) {
      const step = frame.locator(`[data-select="${previousStep}"]`);
      await step.waitFor({ state: "attached" });
      if (await step.isVisible()) await step.click();
      else await step.evaluate((n) => n.click());
    }
  }
  console.log(
    "PASS manual Refresh: visible busy/completion/error/retry, current Git inventory, queued post-poll read, query A→B→A rejects stale failure, drafts/Viewed/After/colours/graph preserved, local button alias."
  );
}
