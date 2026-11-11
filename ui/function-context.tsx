import type { Step } from "../types.mjs";

export function FunctionContextLabel({ step }: { step: Step }) {
  const context = step.code?.functionContext;
  let label = "Source unavailable";
  if (step.code && !step.error) {
    // Context describes current source; explanation freshness is independent.
    if (context?.status === "function") label = context.name;
    else if (context?.status === "multiple") label = "Multiple functions";
    else if (context?.status === "no-function") label = "No enclosing function";
    else label = "Unknown function";
  }
  return <div className="function-context">{label}</div>;
}
