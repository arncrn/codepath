import { useEffect, useRef, useState } from "react";
import { config, inVSCode, onFlowMessage, request } from "./transport";
import { flowState, record, type FlowWindowState } from "./flow-window-wire";
import { WalkthroughFlow } from "./walkthrough-flow";

// No reading-session restoration, API polling, editable notes or saved focus.
// The original reader supplies the current display snapshot and navigation epoch.
export function FlowWindowApp() {
  const [snapshot, setSnapshot] = useState<FlowWindowState | null>(null),
    [error, setError] = useState("Connecting to the original reader…");
  const [lifetime, setLifetime] = useState(() => crypto.randomUUID());
  const current = useRef(snapshot);
  current.current = snapshot;
  const view = useRef(crypto.randomUUID());
  const lastContact = useRef(Date.now()),
    mounted = useRef(true);
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    const receive = (value: unknown) => {
      if (!alive || !record(value) || value.root !== config.root) return;
      if (flowState(value) && value.viewer === view.current) {
        lastContact.current = Date.now();
        current.current = value;
        setSnapshot(value);
        setError("");
        return;
      }
      if (
        !current.current ||
        value.session !== current.current.session ||
        value.viewer !== view.current
      )
        return;
      if (
        value.type === "codepath.flow.heartbeat" &&
        value.epoch === current.current.epoch
      ) {
        lastContact.current = Date.now();
        return;
      }
      if (value.type === "codepath.flow.closed") {
        current.current = null;
        setSnapshot(null);
        setLifetime(crypto.randomUUID());
        setError("Original reader closed. Reopen Flow from Codepath.");
      }
    };
    const browser = (event: MessageEvent<unknown>) => {
      if (event.origin === location.origin && event.source === window.opener)
        receive(event.data);
    };
    const unsubscribe = onFlowMessage(receive);
    window.addEventListener("message", browser);
    const initialView = view.current;
    if (inVSCode)
      void request("flow/ready", { view: initialView }).catch((error) => {
        if (alive && view.current === initialView && !current.current)
          setError(String(error));
      });
    else
      window.opener?.postMessage(
        { type: "codepath.flow.ready", root: config.root, view: view.current },
        location.origin
      );
    const timer = setInterval(() => {
      if (
        Date.now() - lastContact.current > 6000 ||
        (window.opener?.closed && !inVSCode)
      ) {
        if (current.current) {
          current.current = null;
          setSnapshot(null);
          setLifetime(crypto.randomUUID());
          view.current = crypto.randomUUID();
        }
        setError("Original reader disconnected. Reopen Flow from Codepath.");
      }
      if (inVSCode)
        void request(current.current ? "flow/ping" : "flow/ready", {
          view: view.current,
        }).catch(() => {});
      else
        window.opener?.postMessage(
          {
            type: current.current
              ? "codepath.flow.ping"
              : "codepath.flow.ready",
            root: config.root,
            view: view.current,
            session: current.current?.session,
          },
          location.origin
        );
    }, 1000);
    return () => {
      alive = false;
      mounted.current = false;
      current.current = null;
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("message", browser);
    };
  }, []);
  useEffect(() => {
    document.title = "Flow · " + (snapshot?.walkthrough?.title ?? "Codepath");
  }, [snapshot?.walkthrough?.title]);
  return (
    <main id="flow-window">
      <header className="flow-window-header">
        <div>
          <h1>{snapshot?.walkthrough?.title ?? "Codepath Flow"}</h1>
          <p data-flow-window-source>
            {snapshot?.source?.label ?? "Separate Flow window"}
          </p>
          <p>
            {snapshot?.source?.side === "after"
              ? "Node clicks reveal After code in the original reader"
              : "Node clicks select cards in the original reader"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (inVSCode)
              void request("flow/close", { view: view.current }).catch(
                () => {}
              );
            else window.close();
          }}
        >
          Close window
        </button>
      </header>
      {error && <p role="status">{error}</p>}
      {!error && !snapshot?.walkthrough && (
        <p role="status">
          {snapshot?.source?.message ||
            "Open a walkthrough in the original reader to show its Flow."}
        </p>
      )}
      <WalkthroughFlow
        key={(snapshot?.epoch ?? "disconnected") + lifetime}
        walkthrough={snapshot?.walkthrough ?? null}
        changes={snapshot?.source?.changes}
        previewSourceLabel={
          snapshot?.source?.side === "after" ? "After source" : undefined
        }
        hidden={!snapshot?.walkthrough || !!error}
        selectCard={(focus) => {
          const s = current.current;
          if (!s || s !== snapshot) return;
          const message = {
            type: "codepath.flow.select",
            root: config.root,
            session: s.session,
            epoch: s.epoch,
            viewer: s.viewer,
            nodeId: focus.node.id,
          };
          if (inVSCode)
            void request("flow/select", message).catch((error) => {
              if (mounted.current && current.current === s)
                setError(String(error));
            });
          else window.opener?.postMessage(message, location.origin);
        }}
      />
    </main>
  );
}
