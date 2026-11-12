import { test } from "node:test";
import assert from "node:assert/strict";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";
import { authorFixture } from "./fixtures/authored-comparison.mjs";
import {
  mainSource,
  helperSource,
  fixtureSteps,
  fixtureGraph,
} from "./fixtures/semantic-flow.mjs";

test("Current-main Viewed records and Flow survive each other, ordinary updates and reopening without automatic reading credit", async (t) => {
  const f = await gitProject(t),
    { saved } = await authorFixture(f);
  f.write("main.mjs", mainSource);
  f.write("helper.mjs", helperSource);
  let walk = await f.service.call("save_walkthrough", {
    id: "flow-viewed",
    title: "Flow and exact reading progress",
    steps: fixtureSteps,
  });
  const graph = fixtureGraph(walk),
    list = await allChanges(f.service),
    file = list.files.find(
      (x) => x.file === "part.ts" && x.group === "unstaged"
    );
  const pairs = (
      await f.service.call("get_git_viewed", { listId: list.listId })
    ).pairs,
    pair = pairs.find((x) => x.fileId === file.id);
  assert.equal(pair.viewed, false);
  const mark = await f.service.call("set_git_viewed", {
    query: { mode: "changes" },
    fileId: file.id,
    identity: pair.identity,
    expectedRevision: pair.revision,
  });
  walk = await f.service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  assert.deepEqual(
    (
      await f.service.call("get_git_viewed", { listId: list.listId })
    ).pairs.find((x) => x.fileId === file.id),
    { fileId: file.id, ...mark }
  );
  walk = await f.service.call("save_walkthrough", {
    id: walk.id,
    title: "An ordinary title update retains Flow",
    expectedRevision: walk.revision,
    steps: fixtureSteps,
  });
  assert.deepEqual(walk.flow, graph);
  assert.equal(walk.flowState.status, "current");
  const clear = await f.service.call("clear_git_viewed", {
    identity: mark.identity,
    expectedRevision: mark.revision,
  });
  await f.reopen();
  walk = await f.service.call("get_walkthrough", { id: walk.id });
  assert.deepEqual(walk.flow, graph);
  assert.equal(walk.flowState.status, "current");
  const next = await allChanges(f.service),
    read = (await f.service.call("get_git_viewed", { listId: next.listId }))
      .pairs;
  assert.deepEqual(
    read.find((x) => x.fileId === file.id),
    { fileId: file.id, ...clear }
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
});

test("Public HTTP Flow writes, stale reads and clear preserve independent B cards and their two-side annotation histories", async (t) => {
  const f = await gitProject(t);
  const { saved } = await authorFixture(f);
  f.write("main.mjs", mainSource);
  f.write("helper.mjs", helperSource);
  let walk = await f.service.call("save_walkthrough", {
    id: "composed-flow",
    title: "Selected source behavior",
    steps: fixtureSteps,
  });
  const graph = fixtureGraph(walk);
  walk = await f.service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  assert.equal(walk.flowState.status, "current");
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  await f.reopen();
  const revision = (await f.service.call("project_overview", {})).revision;
  f.write("helper.mjs", helperSource + "// different raw full-file bytes\n");
  const stale = await f.service.call("get_walkthrough", { id: walk.id });
  assert.equal(stale.flowState.status, "stale");
  assert.equal(stale.flowState.definition, undefined);
  assert.deepEqual(stale.flow, graph);
  await assert.rejects(
    f.service.call("save_walkthrough_flow", {
      walkthroughId: walk.id,
      expectedRevision: stale.revision,
      graph,
    }),
    /source or linked cards changed/
  );
  assert.equal(
    (await f.service.call("project_overview", {})).revision,
    revision
  );
  walk = await f.service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: stale.revision,
    graph: null,
  });
  assert.equal(walk.flowState.status, "absent");
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  await f.reopen();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
});
