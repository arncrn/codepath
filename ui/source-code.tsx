import { useMemo } from "react";
import type { ReactNode } from "react";
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
  walkthroughId,
  full,
  selectRange,
  reveal,
}: {
  step: Step;
  walkthroughId: string;
  full: boolean;
  selectRange?: (range: SourceAttachment) => void;
  reveal?: (ids: string[]) => void;
}) {
  const syntax = useMemo(
    () => (step.code ? tokenizeSource(step.code.file, step.code.lines) : []),
    [step.code]
  );
  if (step.error || !step.code)
    return (
      <p className="source-error">
        {step.error || "Source is no longer available."}
      </p>
    );
  const code = step.code,
    explanations = attachedExplanations(step),
    blockNotes = attachedBlockNotes(step),
    markerColumns = code.lines.reduce(
      (maximum, _, index) =>
        Math.max(maximum, blocksOnLine(blockNotes, index + 1).length),
      0
    ),
    start = full ? 1 : Math.max(1, code.startLine - 2),
    end = full
      ? code.lines.length
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
                (event.key === " " || (!inVSCode && event.key === "Enter"))
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
    for (const match of inVSCode ? line.matchAll(/[A-Za-z_$][\w$]*/g) : []) {
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
          const range = selectedSourceRange(event.currentTarget, step);
          if (range) selectRange?.(range);
        }}
        onKeyUp={(event) => {
          if (!event.shiftKey) return;
          const range = selectedSourceRange(event.currentTarget, step);
          if (range) selectRange?.(range);
        }}
      >
        {code.lines.slice(start - 1, end).map((line, index) => {
          const blocks = blocksOnLine(blockNotes, index + start);
          return (
            <div
              key={index + start}
              style={
                blocks.length === 1
                  ? {
                      backgroundImage: `linear-gradient(${blocks[0].tint}, ${blocks[0].tint})`,
                    }
                  : undefined
              }
              className={
                "line " +
                (index + start >= code.startLine &&
                index + start <= code.endLine
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
              <span className="line-number">{index + start}</span>
              <code data-source-line={index + start}>
                {sourceText(line, index + start)}
              </code>
            </div>
          );
        })}
      </pre>
    </>
  );
}
