import { useMemo } from "react";
import type { ReactNode } from "react";
import type { DisplayDiffRow } from "./git-diff-rows";
import type { ReferenceContext, SourceAttachment, Step } from "../types.mjs";
import { inVSCode } from "./transport";
import { tokenizeSource } from "./source-syntax";
import { attachedBlockNotes, blocksOnLine } from "./block-notes";
import {
  attachedExplanations,
  lineMatches,
  selectedSourceRange,
} from "./annotations";

export function CodeLines({
  step,
  annotationStep,
  walkthroughId,
  full,
  selectRange,
  clearSelection,
  reveal,
  snapshot = false,
  exact = false,
  changedLines,
  changeKind,
  explanationColors,
  syntax: suppliedSyntax,
  rowLines,
}: {
  step: Step;
  annotationStep?: Step;
  walkthroughId: string;
  full: boolean;
  snapshot?: boolean;
  exact?: boolean;
  changedLines?: Set<number>;
  changeKind?: "removed" | "added";
  explanationColors?: Record<string, string>;
  syntax?: ReturnType<typeof tokenizeSource>;
  rowLines?: readonly DisplayDiffRow[];
  selectRange?: (range: SourceAttachment) => void;
  clearSelection?: () => void;
  reveal?: (ids: string[]) => void;
}) {
  const syntax = useMemo(
    () =>
      suppliedSyntax ??
      (step.code ? tokenizeSource(step.code.file, step.code.lines) : []),
    [suppliedSyntax, step.code]
  );
  if (step.error || !step.code)
    return (
      <p className="source-error">
        {step.error || "Source is no longer available."}
      </p>
    );
  // Display extent is not attachment authority. Both raw file identity and
  // selected authored range must fit before an excerpt can annotate full code.
  const admitted =
    !annotationStep ||
    (!annotationStep.error &&
      !annotationStep.stale &&
      !!annotationStep.code &&
      Number.isSafeInteger(annotationStep.code.startLine) &&
      Number.isSafeInteger(annotationStep.code.endLine) &&
      annotationStep.code.file === step.code.file &&
      annotationStep.code.fileHash === step.code.fileHash &&
      annotationStep.code.startLine >= step.code.startLine &&
      annotationStep.code.endLine <= step.code.endLine);
  const annotation = admitted
    ? (annotationStep ?? step)
    : { ...step, notes: [] };
  const code = step.code,
    explanations = attachedExplanations(annotation),
    blockNotes = attachedBlockNotes(annotation),
    markerColumns = code.lines.reduce(
      (maximum, _, index) =>
        Math.max(maximum, blocksOnLine(blockNotes, index + 1).length),
      0
    ),
    start = full ? 1 : exact ? code.startLine : Math.max(1, code.startLine - 2),
    end = full
      ? code.lines.length
      : exact
        ? code.endLine
        : Math.min(code.lines.length, code.endLine + 2);

  function sourceText(line: string, lineNumber: number) {
    function coloredText(from: number, to: number): ReactNode[] {
      return (syntax[lineNumber - 1] ?? []).flatMap<ReactNode>((run) => {
        const first = Math.max(from, run.startColumn),
          last = Math.min(to, run.endColumn);
        if (first >= last) return [];
        const text = line.slice(first, last);
        return run.kind === "plain"
          ? [text]
          : [
              <span key={first} className={"syntax-" + run.kind}>
                {text}
              </span>,
            ];
      });
    }
    function annotatedText(from: number, to: number) {
      const boundaries = new Set([from, to]);
      for (const explanation of explanations)
        for (const range of explanation.ranges) {
          if (lineNumber < range.startLine || lineNumber > range.endLine)
            continue;
          const first = lineNumber === range.startLine ? range.startColumn : 0,
            last = lineNumber === range.endLine ? range.endColumn : line.length;
          if (first > from && first < to) boundaries.add(first);
          if (last > from && last < to) boundaries.add(last);
        }
      const offsets = [...boundaries].sort((left, right) => left - right);
      return offsets.slice(0, -1).map((first, index) => {
        const last = offsets[index + 1],
          matches = lineMatches(explanations, lineNumber, first, last),
          ids = matches.map((match) => match.id);
        return (
          <span
            key={first}
            className={matches.length ? "source-attachment" : undefined}
            tabIndex={matches.length ? 0 : undefined}
            role={matches.length ? "link" : undefined}
            style={
              matches.length
                ? {
                    textDecoration: "underline dotted",
                    textUnderlineOffset: "3px",
                    cursor: "pointer",
                    ...(explanationColors?.[ids[0]]
                      ? {
                          color: explanationColors[ids[0]],
                          textDecorationColor: explanationColors[ids[0]],
                        }
                      : {}),
                  }
                : undefined
            }
            data-annotation-ids={
              matches.length ? JSON.stringify(ids) : undefined
            }
            aria-label={
              matches.length
                ? line.slice(first, last) +
                  ". " +
                  matches.length +
                  " attached explanations. Space to reveal."
                : undefined
            }
            onClick={(event) => {
              if (
                !matches.length ||
                event.ctrlKey ||
                event.metaKey ||
                !window.getSelection()?.isCollapsed
              )
                return;
              event.stopPropagation();
              reveal?.(ids);
            }}
            onKeyDown={(event) => {
              if (
                matches.length &&
                (event.key === " " ||
                  ((!inVSCode || snapshot) && event.key === "Enter"))
              ) {
                event.preventDefault();
                event.stopPropagation();
                reveal?.(ids);
              }
            }}
          >
            {coloredText(first, last)}
          </span>
        );
      });
    }
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const match of inVSCode && !snapshot
      ? line.matchAll(/[A-Za-z_$][\w$]*/g)
      : []) {
      if (offset < match.index)
        parts.push(
          <span key={"text-" + offset}>
            {annotatedText(offset, match.index)}
          </span>
        );
      const matchingIds = lineMatches(
        explanations,
        lineNumber,
        match.index,
        match.index + match[0].length
      ).map((explanation) => explanation.id);
      const context: ReferenceContext = {
        walkthroughId,
        stepId: step.id,
        fileHash: code.fileHash,
        line: lineNumber,
        column: match.index,
      };
      parts.push(
        <span
          key={"identifier-" + match.index}
          className={
            "source-token" + (matchingIds.length ? " source-attachment" : "")
          }
          tabIndex={0}
          data-annotation-ids={
            matchingIds.length ? JSON.stringify(matchingIds) : undefined
          }
          aria-label={
            matchingIds.length
              ? match[0] +
                ". Space to reveal attached explanations; Enter to follow definition."
              : undefined
          }
          onClick={(event) => {
            if (
              !matchingIds.length ||
              event.ctrlKey ||
              event.metaKey ||
              !window.getSelection()?.isCollapsed
            )
              return;
            event.stopPropagation();
            reveal?.(matchingIds);
          }}
          onKeyDown={(event) => {
            if (
              event.key === " " &&
              matchingIds.length &&
              event.target === event.currentTarget
            ) {
              event.preventDefault();
              event.stopPropagation();
              reveal?.(matchingIds);
            }
          }}
          data-source-name={match[0]}
          data-reference={JSON.stringify(context)}
          title="Right-click to follow definition · Ctrl/Cmd-click or Enter to follow directly"
        >
          {annotatedText(match.index, match.index + match[0].length)}
        </span>
      );
      offset = match.index + match[0].length;
    }
    if (offset < line.length)
      parts.push(
        <span key={"text-" + offset}>{annotatedText(offset, line.length)}</span>
      );
    return parts;
  }
  return (
    <>
      <pre
        onMouseUp={(event) => {
          const range = admitted
            ? selectedSourceRange(event.currentTarget, annotation)
            : null;
          if (range) selectRange?.(range);
          else if (annotationStep) clearSelection?.();
        }}
        onKeyUp={(event) => {
          if (!event.shiftKey) return;
          const range = admitted
            ? selectedSourceRange(event.currentTarget, annotation)
            : null;
          if (range) selectRange?.(range);
          else if (annotationStep) clearSelection?.();
        }}
      >
        {(
          rowLines ??
          Array.from(
            { length: Math.max(0, end - start + 1) },
            (_, i) => start + i
          )
        ).map((lineNumber, index) => {
          if (lineNumber !== null && typeof lineNumber === "object")
            return (
              <div
                key={"hunk-" + index}
                className="diff-hunk"
                data-source-hunk="true"
                role="separator"
              >
                {lineNumber.startLine === null
                  ? "No source lines on this side"
                  : `Lines ${lineNumber.startLine}–${lineNumber.endLine}`}
              </div>
            );
          if (lineNumber === "omitted")
            return (
              <div
                key={"omitted-" + index}
                className="diff-gap"
                data-source-gap="true"
                role="separator"
                aria-label="Unchanged lines omitted"
              >
                … unchanged lines omitted …
              </div>
            );
          if (lineNumber === null)
            return (
              <div
                key={"padding-" + index}
                className="line diff-padding"
                aria-hidden="true"
              >
                <span className="line-number">{"\u00a0"}</span>
              </div>
            );
          const line = code.lines[lineNumber - 1];
          const blocks = blocksOnLine(blockNotes, lineNumber);
          return (
            <div
              key={lineNumber}
              style={
                blocks.length === 1
                  ? {
                      backgroundImage: `linear-gradient(${blocks[0].tint}, ${blocks[0].tint})`,
                    }
                  : undefined
              }
              className={
                "line " +
                (changedLines?.has(lineNumber)
                  ? "diff-" + changeKind + " "
                  : "") +
                (annotationStep &&
                admitted &&
                lineNumber >= annotationStep.code!.startLine &&
                lineNumber <= annotationStep.code!.endLine
                  ? "authored-range "
                  : "") +
                (lineNumber >= code.startLine && lineNumber <= code.endLine
                  ? "focus"
                  : "context")
              }
            >
              {markerColumns > 0 && (
                <span
                  className="block-note-gutter"
                  aria-hidden="true"
                  style={{ width: markerColumns * 4 }}
                >
                  {blocks.map((block) => (
                    <span
                      key={block.id}
                      data-block-note-id={block.id}
                      style={{ backgroundColor: block.color }}
                    />
                  ))}
                </span>
              )}
              <span className="line-number">{lineNumber}</span>
              <code data-source-line={lineNumber}>
                {sourceText(line, lineNumber)}
              </code>
            </div>
          );
        })}
      </pre>
    </>
  );
}
