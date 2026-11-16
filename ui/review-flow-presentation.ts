import { useEffect, useMemo, useRef, useState } from "react";
import type { GitChangesPage, GitQuery, Walkthrough } from "../types.mjs";
import { errorMessage } from "../types.mjs";
import {
  afterLabel,
  proveAfterFlow,
  type AfterProof,
  type AfterWitness,
} from "./after-flow";
import type { useReviewFileLoader } from "./review-file-window";
import type { FlowChanges } from "./flow-changes";
export type ReviewFlowMode = "after" | "walkthrough";
export interface ReviewFlowDisplay {
  key: string;
  mode: ReviewFlowMode;
  walkthrough: Walkthrough | null;
  label: string;
  message: string;
  changes?: FlowChanges;
}
export interface ReviewFlowPresentation {
  display: ReviewFlowDisplay;
  status: "ready" | "checking" | "unavailable";
  files: ReadonlyMap<string, AfterWitness> | null;
  current: () => boolean;
}
export function useReviewFlowPresentation({
  active,
  mode,
  walkthrough,
  query,
  scan,
  owner,
  load,
  reviewId,
}: {
  active: boolean;
  mode: ReviewFlowMode;
  walkthrough: Walkthrough | null;
  query: GitQuery;
  scan: GitChangesPage | null;
  owner: { current: () => boolean };
  load: ReturnType<typeof useReviewFileLoader>;
  reviewId: string | null;
}) {
  const signature = JSON.stringify([
      active,
      mode,
      query,
      scan?.listId,
      scan?.complete,
      reviewId,
      walkthrough?.id,
      walkthrough?.flowState,
      walkthrough?.steps.map((s) => [
        s.id,
        s.code?.hash,
        s.code?.fileHash,
        s.error,
      ]),
    ]),
    scope = useRef({ signature, owner, key: crypto.randomUUID() });
  if (scope.current.signature !== signature || scope.current.owner !== owner)
    scope.current = { signature, owner, key: crypto.randomUUID() };
  const lifetime = scope.current,
    mounted = useRef(true),
    [result, setResult] = useState<{
      scope: typeof lifetime;
      proof: AfterProof;
    } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const current = () =>
      alive &&
      mounted.current &&
      scope.current === lifetime &&
      active &&
      owner.current();
    if (active && mode === "after" && scan?.complete && current())
      void proveAfterFlow(
        walkthrough,
        query,
        scan.files,
        (id) => load(scan.listId, id, current),
        current
      )
        .then((proof) => {
          if (proof && current()) setResult({ scope: lifetime, proof });
        })
        .catch((error) => {
          if (current())
            setResult({
              scope: lifetime,
              proof: {
                status: "unavailable",
                message:
                  "After Flow could not be verified: " + errorMessage(error),
              },
            });
        });
    return () => {
      alive = false;
    };
  }, [lifetime]);
  return useMemo<ReviewFlowPresentation>(() => {
    const proof = result?.scope === lifetime ? result.proof : null,
      ready = mode === "walkthrough" || proof?.status === "ready",
      label = mode === "after" ? afterLabel(query) : "Walkthrough",
      message =
        mode === "after"
          ? proof?.status === "unavailable"
            ? proof.message
            : !proof
              ? "Checking the complete diagram against After source…"
              : ""
          : "";
    return {
      display: {
        key: lifetime.key,
        mode,
        walkthrough: active && ready ? walkthrough : null,
        label,
        message,
        changes:
          mode === "after" && proof?.status === "ready"
            ? proof.changes
            : undefined,
      },
      status: ready ? "ready" : proof ? "unavailable" : "checking",
      files: proof?.status === "ready" ? proof.files : null,
      current: () =>
        mounted.current &&
        scope.current === lifetime &&
        active &&
        owner.current() &&
        ready,
    };
  }, [lifetime, result, walkthrough]);
}
