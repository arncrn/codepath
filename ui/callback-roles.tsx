import { useEffect, useRef, useState } from "react";
import type { CallbackRole, Step, Walkthrough } from "../types.mjs";
import { parseCallbackRole } from "../types.mjs";

const callbackRoles: Record<
  CallbackRole,
  { label: string; explanation: string }
> = {
  registration: {
    label: "Callback registration",
    explanation:
      "Passes or binds a function as a callback. Registration is not the function definition and does not prove it was invoked.",
  },
  definition: {
    label: "Callback function definition",
    explanation:
      "Declares the callback body. A definition alone does not show when or whether it runs.",
  },
  "activation-call-site": {
    label: "Callback activation call site",
    explanation:
      "Source code that invokes the callback if reached. This is a call site, not recorded execution.",
  },
};

export function CallbackRoleSummary({ role }: { role?: CallbackRole }) {
  if (!role) return null;
  const description = callbackRoles[role];
  return (
    <div className="callback-role" data-callback-role={role}>
      <strong>{description.label}</strong>
      <p>{description.explanation}</p>
      <small>Author-assigned source role</small>
    </div>
  );
}

export function CallbackRoleEditor({
  target,
  step,
  save,
  review,
  close,
}: {
  target: Walkthrough;
  step: Step;
  save: (
    target: Walkthrough,
    stepId: string,
    role: CallbackRole | null
  ) => Promise<boolean>;
  review: () => void;
  close: () => void;
}) {
  const [role, setRole] = useState<CallbackRole | undefined>(step.callbackRole);
  const [status, setStatus] = useState<"ready" | "saving" | "conflict">(
    "ready"
  );
  // Only explicit review replaces this snapshot. Polling leaves it pinned.
  useEffect(() => {
    setRole(step.callbackRole);
    setStatus("ready");
  }, [target, step]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      className="form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (status !== "ready") return;
        setStatus("saving");
        const saved = await save(target, step.id, role ?? null);
        if (!mounted.current) return;
        if (saved) close();
        else setStatus("conflict");
      }}
    >
      <p>
        <strong>{step.title}</strong> · {step.source.file} · reviewed path
        revision {target.revision}
      </p>
      <label>
        Role of this highlighted source
        <select
          id="callback-role"
          data-autofocus
          value={role ?? ""}
          disabled={status !== "ready"}
          onChange={(event) =>
            setRole(parseCallbackRole(event.target.value || undefined))
          }
        >
          <option value="">No callback role</option>
          {Object.entries(callbackRoles).map(([value, description]) => (
            <option key={value} value={value}>
              {description.label}
            </option>
          ))}
        </select>
      </label>
      <dl>
        {Object.entries(callbackRoles).map(([value, description]) => (
          <div key={value}>
            <dt>{description.label}</dt>
            <dd>{description.explanation}</dd>
          </div>
        ))}
      </dl>
      <p>
        Assign only after reading this source range. Use Add step to include a
        separate registration, definition or call site. Roles do not verify the
        connection between cards or change recorded/example data.
      </p>
      {(step.stale || step.error) && (
        <p className="source-error">
          Source changed or unavailable. Review the current source before
          assigning a role.
        </p>
      )}
      {status === "conflict" && (
        <p role="status">
          Not saved. Review the latest path before trying again.
        </p>
      )}
      <div>
        <button
          id="save-callback-role"
          className="primary"
          disabled={status !== "ready"}
        >
          {status === "saving" ? "Saving…" : "Save role"}
        </button>
        {status === "conflict" && (
          <button type="button" id="review-callback-role" onClick={review}>
            Review latest
          </button>
        )}
      </div>
    </form>
  );
}
