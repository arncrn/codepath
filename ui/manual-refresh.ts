import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../types.mjs";

export interface RefreshTarget {
  current: () => boolean;
  run: (current: () => boolean) => Promise<void>;
}

// A target is a nonreusable view lease, not an ID. Equal-ID restoration must
// never revive an old completion, failure, or queued operation.
export function useManualRefresh(target: RefreshTarget) {
  const owner = useRef(target);
  owner.current = target;
  const mounted = useRef(false);
  const request = useRef<symbol | null>(null);
  const [result, setResult] = useState<{
    target: RefreshTarget;
    status: "busy" | "done" | "error";
    message: string;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current = null;
    };
  }, []);
  const visible = result?.target === target && target.current() ? result : null;
  return {
    busy: visible?.status === "busy",
    message: visible?.message ?? "",
    failed: visible?.status === "error",
    refresh: async () => {
      if (!mounted.current || !target.current() || visible?.status === "busy")
        return;
      const token = Symbol("manual refresh");
      request.current = token;
      const current = () =>
        mounted.current &&
        owner.current === target &&
        request.current === token &&
        target.current();
      setResult({ target, status: "busy", message: "Refreshing…" });
      try {
        await target.run(current);
        if (current())
          setResult({ target, status: "done", message: "Refreshed" });
      } catch (error) {
        if (current())
          setResult({
            target,
            status: "error",
            message: "Refresh failed: " + errorMessage(error),
          });
      }
    },
  };
}
