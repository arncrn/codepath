import type {
  GitChangedFile,
  GitQuery,
  ToolResults,
  Walkthrough,
} from "../types.mjs";
import { currentFlowSource } from "./flow-source";
import { currentSourceAttachment } from "../source-bindings.mjs";
import { flowChanges, type FlowChange, type FlowChanges } from "./flow-changes";
export interface AfterWitness {
  fileId: string;
  binding: string;
  fileHash: string;
}
export type AfterProof =
  | {
      status: "ready";
      files: ReadonlyMap<string, AfterWitness>;
      changes: FlowChanges;
    }
  | { status: "unavailable"; message: string };
export function afterLabel(query: GitQuery) {
  return query.mode === "changes" || query.target === "WORKING_TREE"
    ? "After · Working tree"
    : query.target.length <= 180
      ? "After · " + query.target
      : "After · selected target";
}
// Entire authored topology is admitted or none is: never prune nodes/edges,
// relocate source, infer a graph or relabel a partially matching graph as After.
export async function proveAfterFlow(
  walk: Walkthrough | null,
  query: GitQuery,
  files: readonly GitChangedFile[],
  read: (fileId: string) => Promise<ToolResults["get_git_file"] | null>,
  current: () => boolean
): Promise<AfterProof | null> {
  const fail = (message: string): AfterProof => ({
    status: "unavailable",
    message: "After Flow " + message,
  });
  if (
    !walk ||
    walk.flowState.status !== "current" ||
    !walk.flowState.nodes?.length ||
    !walk.flowState.definition
  )
    return fail("needs a current authored diagram for this version.");
  const nodes = walk.flowState.nodes;
  if (
    !nodes.every((node) =>
      currentFlowSource(walk, { walkthroughId: walk.id, node })
    )
  )
    return fail("has stale source links.");
  const paths = [...new Set(nodes.map((n) => n.attachment.file))],
    selected = new Map<string, GitChangedFile>();
  for (const path of paths) {
    const candidates = files.filter((f) => f.file === path),
      groups =
        query.mode === "compare"
          ? ["compare"]
          : ["unstaged", "untracked", "staged"];
    let found: GitChangedFile | undefined;
    for (const group of groups) {
      const same = candidates.filter((f) => f.group === group);
      if (same.length > 1)
        return fail("has ambiguous After source for " + path + ".");
      if (same.length) {
        found = same[0];
        break;
      }
    }
    if (!found)
      return fail(
        "cannot verify " +
          path +
          " because its After source is not in this comparison."
      );
    selected.set(path, found);
  }
  const witnesses = new Map<string, AfterWitness>(),
    changes: Record<string, FlowChange> = {};
  for (const [path, file] of selected) {
    if (!current()) return null;
    const view = await read(file.id);
    if (!current()) return null;
    if (
      !view ||
      view.file.id !== file.id ||
      view.after.unavailable ||
      !view.after.code
    )
      return fail("cannot read After source for " + path + ".");
    const code = view.after.code;
    if (
      !nodes
        .filter((n) => n.attachment.file === path)
        .every((n) => currentSourceAttachment(n.attachment, code))
    )
      return fail(
        "does not match After source for " +
          path +
          ". Choose a diagram authored for that version."
      );
    Object.assign(
      changes,
      flowChanges(
        view,
        nodes.filter((n) => n.attachment.file === path)
      )
    );
    witnesses.set(path, {
      fileId: file.id,
      binding: view.binding,
      fileHash: code.fileHash!,
    });
  }
  return current() ? { status: "ready", files: witnesses, changes } : null;
}
