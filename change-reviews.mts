import crypto from "node:crypto";
import { hash } from "./indexer.mjs";
import {
  currentSourceAttachment,
  wholeIdentifierAttachment,
} from "./source-bindings.mjs";
import type {
  ChangeReview,
  ChangeReviewView,
  Note,
  SourceCode,
  ReviewSnapshot,
  SourceAttachment,
} from "./types.mjs";
import { errorMessage } from "./types.mjs";

const MAX_REVIEW_BYTES = 512 * 1024;
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function object(value: unknown): Record<string, unknown> {
  need(
    !!value && typeof value === "object" && !Array.isArray(value),
    "Invalid review object."
  );
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 10000): string {
  need(
    typeof value === "string" && !!value.trim() && value.length <= max,
    "Review text is missing or too long."
  );
  return value.trim();
}
function id(value: unknown): string {
  need(
    typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value),
    "Invalid review/card ID."
  );
  return value;
}
export function reviewFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
function digest(review: Omit<ChangeReview, "fingerprint">): string {
  return reviewFingerprint(JSON.stringify(review));
}
function snapshot(value: unknown, prefix: string): ReviewSnapshot {
  const v = object(value);
  const file = text(v.file, 1000);
  need(
    !file.startsWith("/") &&
      !file.includes("\\") &&
      !file.split("/").some((p) => !p || p === "." || p === ".."),
    "Invalid review source filename."
  );
  need(
    typeof v.content === "string" &&
      v.content.length > 0 &&
      Buffer.byteLength(v.content) <= 128 * 1024,
    "Explicit review source content is required (at most 128 KiB per side)."
  );
  const content = v.content,
    lines = content.split("\n");
  const startLine = v.startLine as number,
    endLine = v.endLine as number;
  need(
    Number.isInteger(startLine) &&
      Number.isInteger(endLine) &&
      startLine >= 1 &&
      endLine >= startLine &&
      endLine <= lines.length &&
      endLine - startLine < 400,
    "Invalid review source range (at most 400 lines)."
  );
  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  const code: SourceCode = {
    file,
    lines,
    startLine,
    endLine,
    excerpt,
    hash: hash(excerpt),
    fileHash: hash(content),
  };
  const notes: Note[] = [];
  const add = (
    body: unknown,
    attachments: SourceAttachment[],
    variableName?: string
  ) => {
    need(
      attachments.length > 0 &&
        attachments.length <= 40 &&
        attachments.every(
          (range) =>
            currentSourceAttachment(range, code) &&
            (!variableName ||
              wholeIdentifierAttachment(range, variableName, code))
        ),
      "Invalid review attachment or whole identifier."
    );
    notes.push({
      id: prefix + "-" + notes.length,
      body: text(body),
      author: "Review author",
      at: "",
      hash: code.hash,
      attachments,
      ...(variableName ? { variableName } : {}),
    });
  };
  const range = (
    first: number,
    last: number,
    startColumn: number,
    endColumn: number
  ): SourceAttachment => ({
    file,
    fileHash: code.fileHash,
    startLine: first,
    endLine: last,
    startColumn,
    endColumn,
    text: lines
      .slice(first - 1, last)
      .map((line, i, all) =>
        line.slice(
          i === 0 ? startColumn : 0,
          i === all.length - 1 ? endColumn : undefined
        )
      )
      .join("\n"),
  });
  need(
    Array.isArray(v.notes) &&
      v.notes.length <= 40 &&
      Array.isArray(v.variables) &&
      v.variables.length <= 40,
    "Provide review Notes and Variables arrays (at most 40 each)."
  );
  for (const entry of v.notes) {
    const n = object(entry),
      first = n.startLine as number,
      last = n.endLine as number;
    add(n.body, [range(first, last, 0, lines[last - 1]?.length ?? -1)]);
  }
  for (const entry of v.variables) {
    const n = object(entry),
      name = text(n.name, 200);
    need(
      /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(name) &&
        Array.isArray(n.occurrences),
      "Invalid review variable."
    );
    add(
      n.body,
      n.occurrences.map((entry: unknown) => {
        const occurrence = object(entry),
          line = occurrence.line as number,
          column = occurrence.startColumn as number;
        return range(line, line, column, column + name.length);
      }),
      name
    );
  }
  const exceptions =
    v.notApplicable === undefined ? {} : object(v.notApplicable);
  const notApplicable: { notes?: string; variables?: string } = {};
  for (const category of ["notes", "variables"] as const) {
    if (exceptions[category] !== undefined)
      notApplicable[category] = text(exceptions[category], 2000);
    need(
      (v[category] as unknown[]).length > 0 || !!notApplicable[category],
      `Review ${category} require attachments or an explicit notApplicable reason.`
    );
  }
  return {
    file,
    content,
    provenance: text(v.provenance, 2000),
    fingerprint: reviewFingerprint(content),
    code,
    purpose: text(v.purpose),
    notes,
    ...(Object.keys(notApplicable).length ? { notApplicable } : {}),
  };
}

// Create-only, synchronous and bounded. No Git, shell, source writes or deferred persistence.
export function captureChangeReview(
  value: unknown,
  currentText: (file: string) => string
): ChangeReview {
  need(
    Buffer.byteLength(JSON.stringify(value) ?? "") <= MAX_REVIEW_BYTES,
    "Review exceeds 512 KiB."
  );
  const v = object(value);
  need(
    Array.isArray(v.cards) && v.cards.length > 0,
    "Provide at least one review card."
  );
  const ids = new Set<string>();
  const review = {
    id: v.id === undefined ? crypto.randomUUID() : id(v.id),
    title: text(v.title, 200),
    capturedAt: new Date().toISOString(),
    cards: v.cards.map((entry: unknown) => {
      const c = object(entry),
        cardId = id(c.id);
      need(!ids.has(cardId), "Duplicate review card ID.");
      ids.add(cardId);
      const before = snapshot(c.before, cardId + "-before"),
        after = snapshot(c.after, cardId + "-after");
      need(
        before.file === after.file,
        "A review card compares the same filename; renames are not supported."
      );
      need(
        before.content !== after.content,
        "Review source content must differ before and after."
      );
      need(
        currentText(after.file) === after.content,
        "After source changed or does not match the live file. Read it again before capturing."
      );
      return {
        id: cardId,
        title: text(c.title, 200),
        beforeBehavior: text(c.beforeBehavior),
        afterBehavior: text(c.afterBehavior),
        reason: text(c.reason),
        before,
        after,
      };
    }),
  };
  need(
    Buffer.byteLength(JSON.stringify(review)) <= MAX_REVIEW_BYTES,
    "Captured review exceeds 512 KiB."
  );
  return { ...review, fingerprint: digest(review) };
}
export function readChangeReview(
  review: ChangeReview,
  currentText: (file: string) => string
): ChangeReviewView {
  return structuredClone({
    ...review,
    live: review.cards.map((card) => {
      try {
        const fingerprint = reviewFingerprint(currentText(card.after.file));
        return {
          cardId: card.id,
          file: card.after.file,
          status:
            fingerprint === card.after.fingerprint
              ? ("matches-after" as const)
              : ("changed" as const),
          fingerprint,
        };
      } catch (error) {
        return {
          cardId: card.id,
          file: card.after.file,
          status: "unavailable" as const,
          error: errorMessage(error),
        };
      }
    }),
  });
}
export function validateChangeReviewState(reviews: ChangeReview[] | undefined) {
  if (reviews === undefined) return;
  need(
    Array.isArray(reviews) && reviews.length <= 20,
    "Invalid saved change reviews."
  );
  const ids = new Set<string>();
  for (const review of reviews) {
    const { fingerprint, ...content } = review;
    need(
      !ids.has(id(review.id)) && fingerprint === digest(content),
      "Saved review fingerprint mismatch or duplicate ID."
    );
    ids.add(review.id);
  }
}
