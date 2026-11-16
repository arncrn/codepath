import type { Walkthrough } from "../types.mjs";
import type { FlowChanges } from "./flow-changes.js";

export interface FlowWindowState {
  type: "codepath.flow.state";
  root: string;
  session: string;
  epoch: string;
  viewer: string;
  walkthrough: Walkthrough | null;
  source?: {
    side: "after";
    label: string;
    message?: string;
    changes?: FlowChanges;
  };
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function changeState(changes: unknown, walk: unknown) {
  if (changes === undefined) return true;
  if (
    !record(changes) ||
    !record(walk) ||
    !record(walk.flowState) ||
    !Array.isArray(walk.flowState.nodes)
  )
    return false;
  const nodes = walk.flowState.nodes;
  return (
    nodes.length <= 120 &&
    Object.keys(changes).length === nodes.length &&
    nodes.every(
      (node) =>
        record(node) &&
        typeof node.id === "string" &&
        /^s\d+$/.test(node.id) &&
        Object.hasOwn(changes, node.id) &&
        (changes[node.id] === "changed" ||
          changes[node.id] === "unchanged" ||
          changes[node.id] === "unknown")
    )
  );
}
export function flowState(value: unknown): value is FlowWindowState {
  return (
    record(value) &&
    value.type === "codepath.flow.state" &&
    typeof value.root === "string" &&
    typeof value.session === "string" &&
    value.session.length <= 100 &&
    typeof value.epoch === "string" &&
    value.epoch.length <= 100 &&
    typeof value.viewer === "string" &&
    value.viewer.length > 0 &&
    value.viewer.length <= 100 &&
    (value.source === undefined ||
      (record(value.source) &&
        value.source.side === "after" &&
        typeof value.source.label === "string" &&
        value.source.label.length <= 1000 &&
        changeState(value.source.changes, value.walkthrough) &&
        (value.source.message === undefined ||
          (typeof value.source.message === "string" &&
            value.source.message.length <= 2000)))) &&
    (value.walkthrough === null ||
      (record(value.walkthrough) &&
        typeof value.walkthrough.id === "string" &&
        typeof value.walkthrough.title === "string" &&
        Array.isArray(value.walkthrough.steps) &&
        record(value.walkthrough.flowState)))
  );
}
// Selection carries no supplied source location or writable tool arguments.
// Resolve its generated node ID from the CURRENT admitted parent snapshot only.
export function flowSelection(value: unknown, current: FlowWindowState) {
  if (
    !record(value) ||
    value.type !== "codepath.flow.select" ||
    value.root !== current.root ||
    value.session !== current.session ||
    value.epoch !== current.epoch ||
    value.viewer !== current.viewer ||
    typeof value.nodeId !== "string" ||
    value.nodeId.length > 100
  )
    return null;
  const walk = current.walkthrough;
  const node = walk?.flowState.nodes?.find((n) => n.id === value.nodeId);
  return walk && node ? { walkthroughId: walk.id, node } : null;
}
