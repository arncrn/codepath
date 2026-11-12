import type { GitViewedRecord, GitViewedInput } from "./types.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export function viewedRequest(value: unknown): {
  identity: string;
  expectedRevision: number;
} {
  need(value && typeof value === "object", "Invalid Viewed request.");
  const v = value as { identity: unknown; expectedRevision: unknown };
  need(
    typeof v.identity === "string" && /^[a-f0-9]{64}$/.test(v.identity),
    "Invalid exact Viewed identity."
  );
  need(
    Number.isSafeInteger(v.expectedRevision) &&
      Number(v.expectedRevision) >= 0 &&
      Number(v.expectedRevision) < Number.MAX_SAFE_INTEGER - 1,
    "Invalid Viewed revision."
  );
  return { identity: v.identity, expectedRevision: Number(v.expectedRevision) };
}
export function viewedMarkRequest(value: unknown): GitViewedInput {
  const revision = viewedRequest(value);
  const v = value as GitViewedInput;
  need(
    typeof v.fileId === "string" && /^[a-f0-9]{64}$/.test(v.fileId),
    "Invalid Viewed file identity."
  );
  need(
    v.query &&
      (v.query.mode === "changes" ||
        (v.query.mode === "compare" &&
          typeof v.query.base === "string" &&
          typeof v.query.target === "string")),
    "Invalid Viewed comparison choices."
  );
  return {
    ...revision,
    fileId: v.fileId,
    query:
      v.query.mode === "changes"
        ? { mode: "changes" }
        : { mode: "compare", base: v.query.base, target: v.query.target },
  };
}
export function validateGitViewed(
  value: unknown
): asserts value is GitViewedRecord[] | undefined {
  if (value === undefined) return;
  need(Array.isArray(value), "Invalid Viewed collection.");
  // Reserve revision digit growth for every retained identity, so clearing an
  // existing mark cannot exhaust storage. Tombstones are never evicted.
  need(
    Buffer.byteLength(JSON.stringify(value)) +
      value.reduce(
        (reserve, record) =>
          reserve +
          Math.max(0, 16 - String(record?.revision).length) +
          Number(record?.viewed === true),
        0
      ) <=
      MAX_BYTES,
    "Viewed history exceeds 2 MiB; no history was evicted."
  );
  const seen = new Set<string>();
  for (const v of value) {
    viewedRequest({ identity: v?.identity, expectedRevision: v?.revision });
    need(
      v.revision > 0 &&
        typeof v.viewed === "boolean" &&
        Object.keys(v).length === 3 &&
        !seen.has(v.identity),
      "Invalid or duplicate Viewed record."
    );
    seen.add(v.identity);
  }
}
export function readGitViewed(
  records: GitViewedRecord[] | undefined,
  identity: string
): GitViewedRecord {
  return {
    ...(records?.find((record) => record.identity === identity) ?? {
      identity,
      revision: 0,
      viewed: false,
    }),
  };
}
export function changeGitViewed(
  records: GitViewedRecord[] | undefined,
  input: { identity: string; expectedRevision: number },
  viewed: boolean
) {
  const request = viewedRequest(input),
    previous = readGitViewed(records, request.identity);
  need(
    previous.revision === request.expectedRevision,
    "Viewed revision changed. Refresh progress before retrying."
  );
  need(viewed || previous.revision > 0, "Viewed identity is not stored.");
  const record = {
    identity: request.identity,
    revision: previous.revision + 1,
    viewed,
  };
  const next = [
    ...(records ?? []).filter((v) => v.identity !== request.identity),
    record,
  ];
  validateGitViewed(next);
  return { records: next, record };
}
