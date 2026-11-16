import type { Walkthrough, ToolResults } from "../types.mjs";
import { currentSourceAttachment } from "../source-bindings.mjs";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";
export type ReviewFlowSide = "before" | "after";
export function reviewFlowSides(
  walk: Walkthrough | null,
  focus: FlowSourceFocus,
  view: ToolResults["get_git_file"]
): ReviewFlowSide[] {
  if (!currentFlowSource(walk, focus)) return [];
  return (["before", "after"] as const).filter(
    (side) =>
      !view[side].unavailable &&
      !!view[side].code &&
      currentSourceAttachment(focus.node.attachment, view[side].code!)
  );
}
