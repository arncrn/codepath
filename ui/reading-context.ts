// UI position only: never source, notes, drafts, runs or connection credentials.
export interface ReadingContext {
  version: 1;
  walkthroughId: string | null;
  stepId: string | null;
  tab: "data" | "notes" | "variables" | "flow";
  focusNonce: string | null;
}
export function parseReadingContext(value: unknown): ReadingContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const id = (s: unknown): s is string | null =>
    s === null || (typeof s === "string" && s.length > 0 && s.length <= 200);
  if (
    v.version !== 1 ||
    !id(v.walkthroughId) ||
    !id(v.stepId) ||
    !id(v.focusNonce) ||
    (v.tab !== "data" &&
      v.tab !== "notes" &&
      v.tab !== "variables" &&
      v.tab !== "flow")
  )
    return null;
  return {
    version: 1,
    walkthroughId: v.walkthroughId,
    stepId: v.stepId,
    tab: v.tab,
    focusNonce: v.focusNonce,
  };
}
export const readingContextKey = (root: string) =>
  "codepath.reading-context.v1:" + root;
