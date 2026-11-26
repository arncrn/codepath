// UI position only: never source, notes, drafts, runs or connection credentials.
export interface ReadingContext {
  version: 1;
  walkthroughId: string | null;
  stepId: string | null;
  tab: "notes" | "variables" | "flow";
  page?: "overview" | "cards";
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
    (v.page !== undefined && v.page !== "overview" && v.page !== "cards") ||
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
    tab: v.tab === "data" ? "notes" : v.tab,
    focusNonce: v.focusNonce,
    ...(v.page === undefined ? {} : { page: v.page }),
  };
}
export const readingContextKey = (root: string) =>
  "codepath.reading-context.v1:" + root;
