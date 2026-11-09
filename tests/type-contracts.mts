import type { ToolClient, SourceRef, StepInput, SavedStep } from "../types.mjs";

// Compiler regression tests: an @ts-expect-error must match a real type error.
// These checks are never executed against a live service.
export function checkContracts(client: ToolClient, source: SourceRef) {
  void client.call("save_walkthrough", {
    title: "Typed path",
    steps: [{ id: "start", title: "Start", source }],
  });
  void client.call("delete_walkthrough", {
    id: "path",
    // @ts-expect-error An existing revision is numeric, not a string.
    expectedRevision: "old",
  });
  // @ts-expect-error Note authors are required.
  void client.call("add_note", {
    walkthroughId: "path",
    stepId: "start",
    body: "Note",
  });
  // @ts-expect-error Only supported tools may cross the host bridge.
  void client.call("execute_arbitrary_code", {});
  const role: StepInput["callbackRole"] = "activation-call-site";
  const clearRole: StepInput["callbackRole"] = null;
  // @ts-expect-error Callback roles describe source, never runtime execution.
  const executed: StepInput["callbackRole"] = "executed";
  // @ts-expect-error Null clears a role at input, but is never persisted.
  const persistedNull: SavedStep["callbackRole"] = null;
  void [role, clearRole, executed, persistedNull];
  // @ts-expect-error A Node application module has no browser document.
  void window.document;
}
