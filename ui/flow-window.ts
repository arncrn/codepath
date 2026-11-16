import { useEffect, useRef, useState } from "react";
import type { Walkthrough } from "../types.mjs";
import { config, inVSCode, onFlowMessage, request } from "./transport";
import { currentFlowSource, type FlowSourceFocus } from "./flow-source";
import {
  flowSelection,
  record,
  type FlowWindowState,
} from "./flow-window-wire";

// One lifetime-bound connection, not persisted focus/progress or shared drafts.
export function useFlowWindow(
  walkthrough: Walkthrough | null,
  enabled: boolean,
  select: (focus: FlowSourceFocus) => void,
  fail: (error: unknown) => void,
  view: "walkthrough" | "review" = "walkthrough",
  reviewId?: string | null,
  source?: FlowWindowState["source"]
) {
  const live = useRef({ walkthrough, enabled, select, fail, source });
  live.current = { walkthrough, enabled, select, fail, source };
  const key = JSON.stringify([
    view,
    reviewId,
    source,
    enabled,
    walkthrough?.id,
    walkthrough?.flowState,
  ]);
  const scope = useRef({ key, epoch: crypto.randomUUID(), life: Symbol() });
  if (scope.current.key !== key)
    scope.current = { key, epoch: crypto.randomUUID(), life: Symbol() };
  const operation = useRef(Symbol()),
    mounted = useRef(true);
  const connection = useRef<{
    id: string;
    child?: Window;
    viewer?: string;
    lease?: string;
    model?: Walkthrough | null;
    epoch?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  function state(): FlowWindowState | null {
    const c = connection.current;
    if (!c?.viewer) return null;
    return {
      type: "codepath.flow.state",
      root: config.root,
      session: c.id,
      epoch: scope.current.epoch,
      viewer: c.viewer,
      walkthrough: live.current.enabled ? live.current.walkthrough : null,
      source: live.current.source,
    };
  }
  function send(force = false) {
    const c = connection.current,
      s = state();
    if (!c || !s) return;
    const full = force || c.model !== s.walkthrough || c.epoch !== s.epoch;
    const message = full
      ? s
      : {
          type: "codepath.flow.heartbeat",
          root: config.root,
          session: c.id,
          epoch: s.epoch,
          viewer: s.viewer,
        };
    c.model = s.walkthrough;
    c.epoch = s.epoch;
    if (c.child) {
      if (!c.child.closed) c.child.postMessage(message, location.origin);
    } else
      void request("flow/publish", message).catch((error) => {
        if (
          mounted.current &&
          connection.current === c &&
          scope.current.epoch === s.epoch &&
          c.viewer === s.viewer
        )
          live.current.fail(error);
      });
  }
  function receive(value: unknown) {
    const c = connection.current;
    if (!c || !record(value)) return;
    if (
      value.type === "codepath.flow.closed" &&
      value.session === c.id &&
      (inVSCode || value.root === config.root)
    ) {
      connection.current = null;
      setRevision((n) => n + 1);
      return;
    }
    if (value.root !== config.root) return;
    if (value.type === "codepath.flow.ready") {
      if (
        typeof value.view === "string" &&
        value.view.length > 0 &&
        value.view.length <= 100
      ) {
        c.viewer = value.view;
        send(true);
      }
      return;
    }
    if (value.type === "codepath.flow.ping") {
      if (value.session === c.id && value.view === c.viewer) send();
      return;
    }
    const s = state();
    if (!s) return;
    const focus = flowSelection(value, s);
    if (
      focus &&
      live.current.enabled &&
      currentFlowSource(live.current.walkthrough, focus)
    )
      live.current.select(focus);
  }
  useEffect(() => {
    mounted.current = true;
    const browser = (event: MessageEvent<unknown>) => {
      if (
        event.origin === location.origin &&
        event.source === connection.current?.child
      )
        receive(event.data);
    };
    const unsubscribe = onFlowMessage((value) => {
      if (
        record(value) &&
        (value.type === "codepath.flow.ready" ||
          value.type === "codepath.flow.ping")
      ) {
        if (value.session === connection.current?.id)
          receive({ ...value, root: config.root });
      } else receive(value);
    });
    window.addEventListener("message", browser);
    const timer = setInterval(() => {
      const c = connection.current;
      if (c?.child?.closed) {
        connection.current = null;
        setRevision((n) => n + 1);
      }
    }, 1000);
    const retire = () => {
      const c = connection.current;
      if (c?.child && !c.child.closed)
        c.child.postMessage(
          {
            type: "codepath.flow.closed",
            root: config.root,
            session: c.id,
            viewer: c.viewer,
          },
          location.origin
        );
      else if (c)
        void request("flow/close", { session: c.id, lease: c.lease }).catch(
          () => {}
        );
      connection.current = null;
    };
    window.addEventListener("pagehide", retire);
    return () => {
      mounted.current = false;
      operation.current = Symbol();
      retire();
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("message", browser);
      window.removeEventListener("pagehide", retire);
    };
  }, []);
  useEffect(() => {
    operation.current = Symbol();
    setBusy(false);
  }, [key]);
  useEffect(() => {
    send();
  }, [key, walkthrough, revision]);
  async function open() {
    const epoch = scope.current.epoch,
      life = scope.current.life,
      op = (operation.current = Symbol());
    if (!live.current.enabled || !live.current.walkthrough) return false;
    setBusy(true);
    try {
      if (inVSCode) {
        const result = await request<{
          session: string;
          lease: string;
          viewer?: string;
          separateWindow: boolean;
        }>("flow/open");
        if (
          !mounted.current ||
          operation.current !== op ||
          scope.current.epoch !== epoch ||
          scope.current.life !== life
        ) {
          void request("flow/close", {
            session: result.session,
            lease: result.lease,
          }).catch(() => {});
          return false;
        }
        connection.current = {
          id: result.session,
          lease: result.lease,
          viewer: result.viewer,
        };
        send(true);
        if (!result.separateWindow)
          live.current.fail(
            Error(
              "Flow opened as a separate tab. This VS Code host cannot create a floating window; use the tab menu to move it."
            )
          );
      } else {
        const previous = connection.current;
        if (previous?.child && !previous.child.closed) {
          previous.child.focus();
          send(true);
          return true;
        }
        const url = new URL(location.href);
        url.search = "?view=flow";
        url.hash = "";
        const child = window.open(
          url.toString(),
          "",
          "popup,width=1100,height=850"
        );
        if (!child)
          throw Error(
            "Your browser blocked the Flow window. Allow popups for this local viewer and try again."
          );
        connection.current = { id: crypto.randomUUID(), child };
      }
      setRevision((n) => n + 1);
      return true;
    } catch (error) {
      if (
        mounted.current &&
        operation.current === op &&
        scope.current.epoch === epoch &&
        scope.current.life === life
      )
        live.current.fail(error);
      return false;
    } finally {
      if (
        mounted.current &&
        operation.current === op &&
        scope.current.epoch === epoch &&
        scope.current.life === life
      )
        setBusy(false);
    }
  }
  return { open: () => open(), busy };
}
