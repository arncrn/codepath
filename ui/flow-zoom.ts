import { useEffect, useRef, useState, type RefObject } from "react";

// Own just the diagram viewport. Scaling never rerenders Mermaid, focuses a
// reader/card, or uses scrollIntoView (which would walk page ancestors).
export function useFlowZoom(target: RefObject<HTMLDivElement | null>) {
  type Canvas = {
    svg: SVGElement;
    width: number;
    height: number;
    scale: number;
    life: symbol;
  };
  const canvas = useRef<Canvas | null>(null),
    observer = useRef<ResizeObserver | null>(null),
    mounted = useRef(true);
  const mode = useRef<number | "fit">(1);
  const [display, setDisplay] = useState({
    scale: 1,
    fit: false,
    ready: false,
  });
  function available() {
    const item = canvas.current,
      view = target.current;
    return mounted.current &&
      item &&
      view &&
      item.svg.isConnected &&
      view.contains(item.svg) &&
      !view.closest("[hidden]")
      ? { item, view }
      : null;
  }
  function apply(value: number | "fit", preserve = true) {
    const active = available();
    if (!active) return;
    const { item, view } = active,
      css = getComputedStyle(view),
      box = view.getBoundingClientRect(),
      old = item.svg.getBoundingClientRect();
    const horizontal =
        parseFloat(css.paddingLeft) + parseFloat(css.paddingRight),
      vertical = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    const scale =
      value === "fit"
        ? Math.max(
            0.0001,
            Math.min(
              1,
              (view.clientWidth - horizontal) / item.width,
              (view.clientHeight - vertical) / item.height
            )
          )
        : Math.max(0.01, Math.min(4, value));
    const centerX = box.left + view.clientLeft + view.clientWidth / 2,
      centerY = box.top + view.clientTop + view.clientHeight / 2;
    const x =
      old.width <= view.clientWidth - horizontal
        ? 0.5
        : (centerX - old.left) / old.width;
    const y =
      old.height <= view.clientHeight - vertical
        ? 0.5
        : (centerY - old.top) / old.height;
    mode.current = value;
    item.scale = scale;
    item.svg.style.width = item.width * scale + "px";
    item.svg.style.height = item.height * scale + "px";
    if (preserve && old.width > 0 && old.height > 0) {
      const next = item.svg.getBoundingClientRect();
      // Scrollbars can appear/disappear as the scaled canvas crosses an edge.
      const nextCenterX = box.left + view.clientLeft + view.clientWidth / 2;
      const nextCenterY = box.top + view.clientTop + view.clientHeight / 2;
      view.scrollTo({
        left: view.scrollLeft + next.left + x * next.width - nextCenterX,
        top: view.scrollTop + next.top + y * next.height - nextCenterY,
        behavior: "instant",
      });
    } else view.scrollTo({ left: 0, top: 0, behavior: "instant" });
    setDisplay((previous) =>
      previous.scale === scale &&
      previous.fit === (value === "fit") &&
      previous.ready
        ? previous
        : { scale, fit: value === "fit", ready: true }
    );
  }
  function install(svg: SVGElement) {
    if (!mounted.current) return;
    const dimensions = svg
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      !dimensions ||
      dimensions.length !== 4 ||
      !dimensions.every(Number.isFinite) ||
      dimensions[2] <= 0 ||
      dimensions[3] <= 0
    )
      throw Error("Invalid Flow dimensions.");
    observer.current?.disconnect();
    const item: Canvas = {
      svg,
      width: dimensions[2],
      height: dimensions[3],
      scale: 1,
      life: Symbol(),
    };
    canvas.current = item;
    apply(mode.current, false);
    const resize = new ResizeObserver(() => {
      if (
        canvas.current === item &&
        canvas.current.life === item.life &&
        mode.current === "fit"
      )
        apply("fit", false);
    });
    observer.current = resize;
    if (target.current) resize.observe(target.current);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      canvas.current = null;
      observer.current?.disconnect();
    };
  }, []);
  function zoom(direction: -1 | 1) {
    const active = available();
    if (!active) return;
    const scale = active.item.scale;
    const next =
      direction > 0
        ? (Math.floor((scale + 0.000001) * 10) + 1) / 10
        : (Math.ceil((scale - 0.000001) * 10) - 1) / 10;
    apply(next);
  }
  return {
    install,
    fit: display.fit,
    percent:
      display.scale < 0.01
        ? (display.scale * 100).toFixed(1) + "%"
        : Math.round(display.scale * 100) + "%",
    canOut: display.ready && display.scale > 0.010001,
    canIn: display.ready && display.scale < 3.999999,
    ready: display.ready,
    out: () => zoom(-1),
    in: () => zoom(1),
    reset: () => apply(1),
    toggleFit: () =>
      apply(mode.current === "fit" ? 1 : "fit", mode.current === "fit"),
  };
}
