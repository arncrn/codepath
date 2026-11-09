import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReferenceContext } from "../types.mjs";
import { followDefinition, openSourceInEditor } from "./api";

export type SourceMenuPosition = {
  reference: ReferenceContext;
  name: string;
  x: number;
  y: number;
};

export function SourceMenu({
  menu,
  close,
  fail,
}: {
  menu: SourceMenuPosition;
  close: () => void;
  fail: (error: unknown) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const bounds = node.getBoundingClientRect();
    node.style.left =
      Math.max(4, Math.min(menu.x, window.innerWidth - bounds.width - 4)) +
      "px";
    node.style.top =
      Math.max(4, Math.min(menu.y, window.innerHeight - bounds.height - 4)) +
      "px";
    node.querySelector("button")!.focus({ preventScroll: true });
  }, [menu]);
  const runSourceAction = (
    action: (reference: ReferenceContext) => Promise<unknown>
  ) => {
    close();
    void action(menu.reference).catch(fail);
  };
  return createPortal(
    <div
      id="source-menu"
      role="menu"
      ref={ref}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...ref.current!.querySelectorAll("button")];
        const activeButton = document.activeElement;
        const focusedIndex =
          activeButton instanceof HTMLButtonElement
            ? buttons.indexOf(activeButton)
            : -1;
        buttons[
          (focusedIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            buttons.length) %
            buttons.length
        ].focus();
      }}
    >
      <button
        role="menuitem"
        data-symbol-follow
        onClick={() => runSourceAction(followDefinition)}
      >
        Follow definition of {menu.name}
      </button>
      <button
        role="menuitem"
        data-symbol-open
        onClick={() => runSourceAction(openSourceInEditor)}
      >
        Open source in editor
      </button>
    </div>,
    document.body
  );
}
