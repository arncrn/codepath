import { useEffect, useRef, useState } from "react";
import type { GitChangedFile, Walkthrough, ToolResults } from "../types.mjs";
import { errorMessage } from "../types.mjs";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";
import { reviewFlowSides, type ReviewFlowSide } from "./review-flow-source";
import type { useReviewFileLoader } from "./review-file-window";
import type { ReviewFlowPresentation } from "./review-flow-presentation";
export interface ReviewFlowRequest {
  focus: FlowSourceFocus;
  token: symbol;
  contextKey?: string;
}
export interface ReviewFlowTarget {
  listId: string;
  fileId: string;
  binding: string;
  view: ToolResults["get_git_file"];
  sides: ReviewFlowSide[];
}
interface Navigation {
  life: symbol;
  token: symbol;
  focus: FlowSourceFocus;
  targets: ReviewFlowTarget[];
  target?: ReviewFlowTarget;
  message: string;
}
export function useReviewFlow({
  active,
  walkthrough,
  scan,
  owner,
  load,
  reveal,
  request,
  visible: canvasVisible,
  reviewId,
  presentation,
}: {
  presentation: ReviewFlowPresentation;
  reviewId?: string | null;
  visible: boolean;
  active: boolean;
  walkthrough: Walkthrough | null;
  scan: {
    listId: string;
    complete: boolean;
    files: readonly GitChangedFile[];
  } | null;
  owner: { current: () => boolean };
  load: ReturnType<typeof useReviewFileLoader>;
  reveal: (selection: Navigation) => void;
  request?: ReviewFlowRequest | null;
}) {
  const graph = JSON.stringify([
      walkthrough?.flowState,
      walkthrough?.steps.map((step) => [
        step.id,
        step.code?.hash,
        step.code?.fileHash,
        step.error,
      ]),
      canvasVisible,
      reviewId,
      presentation.display.key,
    ]),
    scope = useRef({
      active,
      graph,
      id: walkthrough?.id,
      listId: scan?.listId,
      owner,
      life: Symbol("review Flow"),
    });
  if (
    scope.current.active !== active ||
    scope.current.graph !== graph ||
    scope.current.id !== walkthrough?.id ||
    scope.current.listId !== scan?.listId ||
    scope.current.owner !== owner
  )
    scope.current = {
      active,
      graph,
      id: walkthrough?.id,
      listId: scan?.listId,
      owner,
      life: Symbol("review Flow"),
    };
  const [navigation, setNavigation] = useState<Navigation | null>(null),
    operation = useRef(Symbol()),
    mounted = useRef(true),
    consumed = useRef<symbol | null>(null),
    latest = useRef({ active, walkthrough, scan, owner, reveal, presentation });
  latest.current = { active, walkthrough, scan, owner, reveal, presentation };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = Symbol("retired review Flow");
    };
  }, []);
  function current(n: Navigation) {
    return (
      mounted.current &&
      scope.current.life === n.life &&
      operation.current === n.token &&
      latest.current.active &&
      latest.current.owner.current() &&
      latest.current.presentation.current() &&
      currentFlowSource(latest.current.walkthrough, n.focus)
    );
  }
  function choose(n: Navigation, target: ReviewFlowTarget) {
    if (
      !current(n) ||
      !n.targets.includes(target) ||
      !reviewFlowSides(latest.current.walkthrough, n.focus, target.view).length
    )
      return;
    const next = {
      ...n,
      target,
      message: `${target.view.file.group} · ${target.sides.map((side) => (side === "after" ? "After" : "Before")).join(" and ")} · ${target.view.file.file} · lines ${n.focus.node.attachment.startLine}–${n.focus.node.attachment.endLine}`,
    };
    setNavigation(next);
    latest.current.reveal(next);
  }
  async function select(focus: FlowSourceFocus) {
    const live = latest.current,
      life = scope.current.life,
      token = (operation.current = Symbol("Flow source selection"));
    if (!live.active || !currentFlowSource(live.walkthrough, focus)) return;
    const base: Navigation = {
      life,
      token,
      focus,
      targets: [],
      message: "Checking compared source…",
    };
    setNavigation(base);
    if (!live.scan?.complete || !live.owner.current()) {
      setNavigation({
        ...base,
        message:
          "Comparison is loading or unavailable. No source location selected.",
      });
      return;
    }
    const scan = live.scan,
      candidates = scan.files.filter((file) =>
        live.presentation.display.mode === "after"
          ? live.presentation.files?.get(focus.node.attachment.file)?.fileId ===
            file.id
          : file.file === focus.node.attachment.file ||
            file.oldFile === focus.node.attachment.file
      );
    try {
      const views = await Promise.all(
        candidates.map(async (file) => {
          const view = await load(scan.listId, file.id, () => current(base));
          if (!view || view.file.id !== file.id) return null;
          const after = live.presentation.display.mode === "after",
            witness = live.presentation.files?.get(focus.node.attachment.file);
          if (
            after &&
            (!witness ||
              witness.binding !== view.binding ||
              witness.fileId !== view.file.id)
          )
            return null;
          const sides = reviewFlowSides(
            latest.current.walkthrough,
            focus,
            view
          ).filter((side) => !after || side === "after");
          return sides.length
            ? {
                listId: scan.listId,
                fileId: file.id,
                binding: view.binding,
                view,
                sides,
              }
            : null;
        })
      );
      if (!current(base)) return;
      const targets = views.filter(
          (target): target is ReviewFlowTarget => target !== null
        ),
        next = { ...base, targets };
      if (targets.length === 1) choose(next, targets[0]);
      else
        setNavigation({
          ...next,
          message: targets.length
            ? "This source version occurs in multiple compared pairs. Choose the pair to reveal."
            : "This node has no exact source version in the selected comparison. No code was highlighted.",
        });
    } catch (error) {
      if (current(base))
        setNavigation({ ...base, message: errorMessage(error) });
    }
  }
  useEffect(() => {
    if (!request || consumed.current === request.token) return;
    consumed.current = request.token;
    if (request.contextKey !== latest.current.presentation.display.key) return;
    if (latest.current.active) void select(request.focus);
  }, [request]);
  const visible = navigation && current(navigation) ? navigation : null;
  return {
    select,
    selection: visible?.target ? visible : null,
    message: visible?.message ?? "",
    choices: visible && !visible.target ? visible.targets : [],
    choose: (target: ReviewFlowTarget) => {
      if (visible) choose(visible, target);
    },
    current,
  };
}
