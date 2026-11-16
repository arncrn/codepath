import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getGitFile } from "./api";
import type { ToolResults } from "../types.mjs";

// Headers stay in document order. Far-away code is replaced with its measured
// height, but an open editor and the explicitly selected file never unmount.
export function ReviewFileWindow({
  active,
  selected,
  children,
}: {
  active: boolean;
  selected: boolean;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const height = useRef(320);
  const [near, setNear] = useState(false);
  const [editing, setEditing] = useState(false);
  const enabled = active && (near || selected || editing);
  useEffect(() => {
    const node = element.current;
    if (!active || !node) return;
    let live = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (live && element.current === node) setNear(entry.isIntersecting);
      },
      { root: node.closest("#current-changes"), rootMargin: "800px 0px" }
    );
    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [active]);
  useEffect(() => {
    const node = element.current;
    if (!enabled || !node) return;
    let live = true;
    const measure = () => {
      if (live && element.current === node)
        height.current = Math.max(320, node.offsetHeight);
    };
    const pin = () => {
      if (live && element.current === node)
        setEditing(!!node.querySelector("textarea"));
    };
    const resize = new ResizeObserver(measure);
    const mutation = new MutationObserver(pin);
    resize.observe(node);
    mutation.observe(node, { childList: true, subtree: true });
    measure();
    pin();
    return () => {
      live = false;
      resize.disconnect();
      mutation.disconnect();
    };
  }, [enabled]);
  return (
    <div
      ref={element}
      className="review-file-window"
      style={{ minHeight: enabled ? 320 : height.current }}
      data-source-window={enabled ? "open" : "deferred"}
    >
      {enabled ? (
        children
      ) : (
        <p className="source-deferred">Source loads as you scroll.</p>
      )}
    </div>
  );
}

// An explicit file jump remains anchored while neighboring lazy sources finish.
// Any real reading gesture cancels the intent; later resizes must not snap back.
export function useFileJump(active: boolean, lifetime: symbol) {
  const container = useRef<HTMLDivElement>(null);
  const owner = useRef({ active, lifetime });
  if (owner.current.active !== active || owner.current.lifetime !== lifetime)
    owner.current = { active, lifetime };
  const intent = useRef<{
    node: HTMLElement;
    noteStepId?: string;
    owner: typeof owner.current;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const scheduled = useRef<symbol | null>(null);
  function schedule() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const request = intent.current,
      version = Symbol("file reveal frame");
    scheduled.current = version;
    frame.current = requestAnimationFrame(() => {
      if (scheduled.current !== version) return;
      frame.current = null;
      if (
        !request ||
        intent.current !== request ||
        owner.current !== request.owner ||
        !request.owner.active
      )
        return;
      const node = request.node,
        root = node.closest<HTMLElement>("#current-changes");
      if (
        !node.isConnected ||
        !root ||
        root.hidden ||
        root.ownerDocument.querySelector("dialog[open]")
      ) {
        intent.current = null;
        return;
      }
      root.scrollTo({
        top:
          root.scrollTop +
          node.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          12,
      });
      if (request.noteStepId) {
        const card = [
          ...node.querySelectorAll<HTMLElement>("[data-walkthrough-card]"),
        ].find(
          (card) =>
            card.dataset.walkthroughCard === request.noteStepId &&
            card.querySelector("[data-walkthrough-note-id]")
        );
        const notes = card?.querySelector<HTMLElement>(
          ".walkthrough-note-columns"
        );
        const scroll = notes?.closest<HTMLElement>(".comparison-scroll");
        if (notes && scroll) {
          const box = notes.getBoundingClientRect(),
            pane = scroll.getBoundingClientRect(),
            outer = root.getBoundingClientRect();
          const left = Math.max(pane.left, outer.left, 0),
            right = Math.min(pane.right, outer.right, innerWidth);
          const scale = pane.width / scroll.offsetWidth || 1;
          if (box.right > right)
            scroll.scrollLeft += (box.right - right + 4) / scale;
          else if (box.left < left)
            scroll.scrollLeft -= (left - box.left + 4) / scale;
        }
      }
      if (node.hasAttribute("data-flow-source")) {
        const code = node.closest<HTMLElement>(".code"),
          pair = node.closest<HTMLElement>(".comparison-scroll");
        for (const scroll of [pair, code]) {
          if (!scroll) continue;
          const pane = scroll.getBoundingClientRect(),
            outer = root.getBoundingClientRect();
          const left = Math.max(pane.left, outer.left, 0),
            right = Math.min(pane.right, outer.right, innerWidth),
            scale = pane.width / scroll.offsetWidth || 1;
          const target =
              scroll === pair &&
              code &&
              code.getBoundingClientRect().width <= right - left
                ? code
                : node,
            box = target.getBoundingClientRect();
          if (box.right > right)
            scroll.scrollLeft += (box.right - right + 4) / scale;
          else if (box.left < left)
            scroll.scrollLeft -= (left - box.left + 4) / scale;
        }
      }
    });
  }
  useEffect(() => {
    const node = container.current,
      instance = owner.current;
    if (!active || !node) return;
    const root = node.closest("#current-changes");
    if (!root) return;
    let live = true;
    const cancel = () => {
      if (intent.current && intent.current.owner !== instance) return;
      intent.current = null;
      scheduled.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    const resize = new ResizeObserver(() => {
      if (live && owner.current === instance && intent.current) schedule();
    });
    resize.observe(node);
    const gestures = ["wheel", "pointerdown", "keydown", "touchstart"];
    for (const name of gestures)
      root.addEventListener(name, cancel, { capture: true, passive: true });
    return () => {
      live = false;
      resize.disconnect();
      cancel();
      for (const name of gestures) root.removeEventListener(name, cancel, true);
    };
  }, [active, lifetime]);
  return {
    container,
    reveal: (node: HTMLElement, noteStepId?: string) => {
      const request = { node, noteStepId, owner: owner.current };
      intent.current = request;
      schedule();
      return () => {
        if (intent.current !== request) return;
        intent.current = null;
        scheduled.current = null;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
      };
    },
  };
}

// One queue across query/view lifetimes: old in-flight reads still occupy their
// permits until drained. Canceled queued reads never start a Git operation.
export function useReviewFileLoader() {
  return useMemo(() => {
    type Result = ToolResults["get_git_file"] | null;
    const queue: {
      listId: string;
      fileId: string;
      current: () => boolean;
      resolve: (value: Result) => void;
      reject: (error: unknown) => void;
    }[] = [];
    let running = 0;
    function pump() {
      while (running < 2 && queue.length) {
        const job = queue.shift()!;
        if (!job.current()) {
          job.resolve(null);
          continue;
        }
        running++;
        void getGitFile({ listId: job.listId, fileId: job.fileId })
          .then(
            (value) => job.resolve(job.current() ? value : null),
            job.reject
          )
          .finally(() => {
            running--;
            pump();
          });
      }
    }
    return (listId: string, fileId: string, current: () => boolean) =>
      new Promise<Result>((resolve, reject) => {
        queue.push({ listId, fileId, current, resolve, reject });
        pump();
      });
  }, []);
}
