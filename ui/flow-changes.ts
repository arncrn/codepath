import type { GitFileView, SourceAttachment } from "../types.mjs";
import { currentSourceAttachment } from "../source-bindings.mjs";
import { diffRows } from "./git-diff-rows.js";
export type FlowChange = "changed" | "unchanged" | "unknown";
export type FlowChanges = Readonly<Record<string, FlowChange>>;
export const flowChangeLabels: Record<FlowChange, string> = {
  changed: "Changed source lines",
  unchanged: "Unchanged source lines",
  unknown: "Change status unavailable",
};
// Display classification only, never source/edit authority or a claim about
// behavior. Parse the already raw-verified alignment once per file. A node is
// changed for added/replaced selected After lines, or an internal deletion seam.
export function flowChanges(
  view: GitFileView,
  nodes: readonly { id: string; attachment: SourceAttachment }[]
): FlowChanges {
  const rows =
      view.before.unavailable || view.after.unavailable ? null : diffRows(view),
    same =
      view.before.content !== undefined &&
      view.before.content === view.after.content &&
      !view.before.unavailable &&
      !view.after.unavailable,
    seams: { before: number; after: number }[] = [],
    added = rows ? [...rows.added] : [];
  if (rows) {
    let previous = 0;
    for (let i = 0; i < rows.after.length; i++) {
      const line = rows.after[i];
      if (line !== null) {
        previous = line;
        continue;
      }
      const start = i;
      while (i + 1 < rows.after.length && rows.after[i + 1] === null) i++;
      const next = rows.after[i + 1];
      if (
        previous &&
        next !== undefined &&
        next !== null &&
        rows.before
          .slice(start, i + 1)
          .some((line) => line !== null && rows.removed.has(line))
      )
        seams.push({ before: previous, after: next });
    }
  }
  return Object.fromEntries(
    nodes.map((node) => {
      const a = node.attachment,
        last = a.endLine - Number(a.endLine > a.startLine && a.endColumn === 0);
      let kind: FlowChange = "unknown";
      if (view.after.code && currentSourceAttachment(a, view.after.code)) {
        if (same) kind = "unchanged";
        else if (rows)
          kind =
            added.some((line) => line >= a.startLine && line <= last) ||
            seams.some(
              (seam) => seam.before >= a.startLine && seam.after <= last
            )
              ? "changed"
              : "unchanged";
      }
      return [node.id, kind];
    })
  );
}
