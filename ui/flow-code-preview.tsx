import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Walkthrough } from "../types.mjs";
import type { FlowSourceFocus } from "./flow-source";
import { CodeLines } from "./source-code";
import { tokenizeSource, type SyntaxRun } from "./source-syntax";

// Display-only limits, never source/graph truncation or attachment authority.
const maxLines = 60,
  maxBytes = 24 * 1024;
export function FlowCodePreview({
  walkthrough,
  focus,
  anchor,
  id,
  enter,
  leave,
  close,
  sourceLabel = "Walkthrough source",
}: {
  sourceLabel?: string;
  walkthrough: Walkthrough;
  focus: FlowSourceFocus;
  anchor: SVGElement;
  id: string;
  enter: () => void;
  leave: () => void;
  close: (returnFocus: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const step = walkthrough.steps.find((s) => s.id === focus.node.stepId)!;
  const view = useMemo(() => {
    const code = step.code!,
      a = focus.node.attachment;
    const first = Math.max(1, a.startLine - 2),
      end = Math.min(code.lines.length, a.endLine + 2);
    const rows: number[] = [];
    let bytes = 0;
    for (let line = first; line <= end && rows.length < maxLines; line++) {
      const text = code.lines[line - 1];
      if (
        text.length > maxBytes ||
        bytes + new TextEncoder().encode(text).length + 1 > maxBytes
      )
        break;
      rows.push(line);
      bytes += new TextEncoder().encode(text).length + 1;
    }
    // Keep full lexical context for small files, plain literal text otherwise.
    // Do not tokenize an unbounded whole file just to show a small hover.
    let chars = 0;
    for (const text of code.lines) {
      chars += text.length + 1;
      if (chars > 65536) break;
    }
    const plain: SyntaxRun[][] = [];
    if (chars > 65536)
      for (const line of rows)
        plain[line - 1] = [
          {
            line,
            startColumn: 0,
            endColumn: code.lines[line - 1].length,
            kind: "plain",
          },
        ];
    const syntax =
      chars <= 65536 ? tokenizeSource(code.file, code.lines) : plain;
    return {
      rows,
      syntax,
      limited: (rows.at(-1) ?? 0) < end,
      usable: rows.includes(a.startLine),
      step: {
        ...step,
        notes: [],
        code: { ...code, startLine: a.startLine, endLine: a.endLine },
      },
    };
  }, [step, focus]);
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const a = anchor.getBoundingClientRect(),
      gap = 8;
    const left = Math.max(
      gap,
      Math.min(a.left, window.innerWidth - box.width - gap)
    );
    const below = a.bottom + gap,
      above = a.top - box.height - gap;
    const top =
      below + box.height <= window.innerHeight - gap
        ? below
        : above >= gap
          ? above
          : Math.max(
              gap,
              Math.min(a.top, window.innerHeight - box.height - gap)
            );
    setPosition({ left, top });
  }, [anchor, focus]);
  useLayoutEffect(() => {
    const pane = root.current?.querySelector<HTMLElement>(".code"),
      mark = pane?.querySelector<HTMLElement>("[data-flow-source]");
    if (!pane || !mark || !position) return;
    const p = pane.getBoundingClientRect(),
      m = mark.getBoundingClientRect();
    pane.scrollTo({
      left: Math.max(0, m.left - p.left - 45),
      top: Math.max(0, m.top - p.top - 35),
      behavior: "instant",
    });
  }, [position]);
  const a = focus.node.attachment;
  return createPortal(
    <div
      id={id}
      ref={root}
      className="flow-code-preview"
      data-flow-code-preview
      role="dialog"
      aria-label="Flow code preview"
      aria-describedby={id + "-help"}
      style={{
        left: position?.left ?? 8,
        top: position?.top ?? 8,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onFocusCapture={enter}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) leave();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight")
          event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <header>
        <div>
          <strong>{focus.node.label}</strong>
          <div>{step.title}</div>
        </div>
        <button
          type="button"
          aria-label="Close code preview"
          onClick={() => close(true)}
        >
          ×
        </button>
      </header>
      <p className="flow-preview-location">
        {sourceLabel} · {a.file} ·{" "}
        {a.startLine === a.endLine
          ? `Line ${a.startLine}`
          : `Lines ${a.startLine}–${a.endLine}`}
      </p>
      {view.usable ? (
        <div className="code" tabIndex={0} aria-label="Preview source code">
          <CodeLines
            step={view.step}
            walkthroughId={walkthrough.id}
            full={false}
            snapshot
            rowLines={view.rows}
            syntax={view.syntax}
            flowSource={a}
          />
        </div>
      ) : (
        <p className="flow-preview-limit">
          Source is too large for a hover preview. Select the node to read its
          card.
        </p>
      )}
      {view.usable && view.limited && (
        <p className="flow-preview-limit">
          Preview shows lines {view.rows[0]}–{view.rows.at(-1)} only. Select the
          node to read the full card.
        </p>
      )}
      <p id={id + "-help"} className="flow-preview-help">
        Read-only preview · Click code to focus · Esc to dismiss
      </p>
    </div>,
    document.body
  );
}
