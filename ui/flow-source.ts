import type { FlowState, Walkthrough } from "../types.mjs";
import { currentSourceAttachment } from "../source-bindings.mjs";

export type FlowSourceNode = NonNullable<FlowState["nodes"]>[number];
export interface FlowSourceFocus {
  walkthroughId: string;
  node: FlowSourceNode;
}
function identity(node: FlowSourceNode) {
  const a = node.attachment;
  return JSON.stringify([
    node.id,
    node.stepId,
    node.label,
    node.sourceHash,
    a.file,
    a.fileHash,
    a.startLine,
    a.startColumn,
    a.endLine,
    a.endColumn,
    a.text,
  ]);
}
// Read-only display authority, separate from annotation selection and drafts.
export function currentFlowSource(
  walk: Walkthrough | null,
  focus: FlowSourceFocus | null
): boolean {
  if (
    !focus ||
    walk?.id !== focus.walkthroughId ||
    walk.flowState.status !== "current"
  )
    return false;
  const node = walk.flowState.nodes?.find((n) => n.id === focus.node.id);
  const step = walk.steps.find((s) => s.id === focus.node.stepId);
  return (
    !!node &&
    identity(node) === identity(focus.node) &&
    !!step?.code &&
    !step.error &&
    step.code.hash === node.sourceHash &&
    currentSourceAttachment(node.attachment, step.code)
  );
}
