import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import type {
  CallbackRole,
  Overview,
  SourceRef,
  Step,
  Walkthrough,
} from "../types.mjs";
import { config, inVSCode } from "./transport";
import { Picker } from "./source-picker";
import { CallbackRoleEditor } from "./callback-roles";

export type Modal =
  | { kind: "create" }
  | { kind: "picker"; file?: string }
  | { kind: "repair"; target: Walkthrough; stepId: string }
  | { kind: "delete"; target: Walkthrough; runs: number }
  | { kind: "callback-role"; target: Walkthrough; step: Step }
  | { kind: "agent" }
  | { kind: "demo" };

export interface DialogRequest {
  isCurrent(): boolean;
  open(modal: Modal): void;
  close(): void;
}

export function useDialogs() {
  const [modal, setModal] = useState<Modal | null>(null);
  const latestDialogRequestNumber = useRef(0);
  const invalidatePendingRequests = useCallback(() => {
    latestDialogRequestNumber.current++;
  }, []);
  useEffect(() => invalidatePendingRequests, [invalidatePendingRequests]);
  function open(value: Modal) {
    invalidatePendingRequests();
    setModal(value);
  }
  function close() {
    invalidatePendingRequests();
    setModal(null);
  }
  function beginRequest(): DialogRequest {
    const thisDialogRequestNumber = ++latestDialogRequestNumber.current;
    const isCurrent = () =>
      thisDialogRequestNumber === latestDialogRequestNumber.current;
    return {
      isCurrent,
      open(value) {
        if (isCurrent()) open(value);
      },
      close() {
        if (isCurrent()) close();
      },
    };
  }
  return { modal, open, close, beginRequest, invalidatePendingRequests };
}

function CreateForm({
  create,
}: {
  create: (title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState("");
  return (
    <form
      id="create-form"
      className="form"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        void create(title, description);
      }}
    >
      <label>
        Name
        <input
          id="path-name"
          placeholder="What happens when a user clicks Submit?"
          required
          data-autofocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Situation / expected outcome
        <textarea
          id="path-description"
          placeholder="A signed-in user submits a valid order…"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button className="primary">Create walkthrough →</button>
    </form>
  );
}

function DeleteConfirmation({
  target,
  runs,
  remove,
  review,
}: {
  target: Walkthrough;
  runs: number;
  remove: () => Promise<boolean>;
  review: () => void;
}) {
  const [pending, setPending] = useState(false),
    [conflict, setConflict] = useState(false);
  const count = (quantity: number, label: string) =>
    quantity + " " + label + (quantity === 1 ? "" : "s");
  return (
    <div className="form">
      <p>
        Delete <strong>{target.title}</strong>?
      </p>
      <p>
        {count(target.steps.length, "step")},{" "}
        {count(
          target.steps.reduce(
            (quantity, step) => quantity + step.notes.length,
            0
          ),
          "note"
        )}{" "}
        and {count(runs, "saved run")} will be permanently removed.
      </p>
      <p>Source files and other walkthroughs will not be changed.</p>
      <div className="delete-actions">
        <button
          id="cancel-delete"
          className="secondary"
          data-autofocus
          onClick={() =>
            document.querySelector<HTMLDialogElement>("#modal")!.close()
          }
        >
          Cancel
        </button>
        <button
          id="review-delete"
          className="secondary"
          hidden={!conflict}
          onClick={review}
        >
          Review latest
        </button>
        <button
          id="confirm-delete"
          className="primary danger"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            if (!(await remove())) setConflict(true);
          }}
        >
          Delete walkthrough
        </button>
      </div>
    </div>
  );
}

function AgentInstructions({ fail }: { fail: (error: unknown) => void }) {
  const [copied, setCopied] = useState(false),
    mcp = {
      mcpServers: {
        codepath: {
          command: "node",
          args: [config.toolRoot + "/agent.mjs", "--root", config.root],
        },
      },
    };
  return (
    <div className="agent-content">
      <p>
        {inVSCode
          ? "VS Code manages the local service while this window is open."
          : "Keep this local server running."}{" "}
        Merge this entry into your coding agent’s MCP configuration.
      </p>
      <pre id="mcp-config">{JSON.stringify(mcp, null, 2)}</pre>
      <button
        className="secondary"
        id="copy-mcp"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(JSON.stringify(mcp, null, 2));
            setCopied(true);
          } catch {
            fail("Select and copy the configuration manually.");
          }
        }}
      >
        {copied ? "Copied" : "Copy configuration"}
      </button>
      <h3>Give your agent a specific behavior</h3>
      <blockquote>
        Use Codepath to map what happens when a user clicks Submit. Read source
        first. Include the frontend handler, request, backend route, service,
        repository and response/render path. For each highlighted range, explain
        what the whole function does in the card description (high level). Add
        Notes that explain code blocks and function calls (medium level), then
        the purpose of individual variables (low level). Do not repeat the
        summary. Keep setup history and review findings out of code
        explanations. For a code review, describe the behavior before and after
        the change. Mark uncertain connections inferred. Use example mode for
        invented values.
      </blockquote>
      <h3>Command-line fallback</h3>
      <pre>
        node {JSON.stringify(config.toolRoot + "/agent.mjs")} --root{" "}
        {JSON.stringify(config.root)} --call project_overview
      </pre>
      <small>
        Codepath contains no AI model. It uses your existing agent. No GitHub
        connection is needed.
      </small>
    </div>
  );
}

export function Dialogs({
  modal,
  close,
  error,
  overview,
  create,
  addSource,
  repairSource,
  removePath,
  openDelete,
  saveCallbackRole,
  openCallbackRole,
  refresh,
  fail,
}: {
  modal: Modal | null;
  close: () => void;
  error: string;
  overview: Overview | null;
  create: (title: string, description: string) => Promise<void>;
  addSource: (source: SourceRef, title: string) => Promise<void>;
  repairSource: (
    target: Walkthrough,
    stepId: string,
    source: SourceRef,
    fileHash: string
  ) => Promise<void>;
  removePath: (target: Walkthrough) => Promise<boolean>;
  openDelete: (id: string) => Promise<void>;
  saveCallbackRole: (
    target: Walkthrough,
    stepId: string,
    role: CallbackRole | null
  ) => Promise<boolean>;
  openCallbackRole: (stepId: string, id: string) => Promise<void>;
  refresh: () => Promise<void>;
  fail: (error: unknown) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    if (modal) {
      if (!node.open) node.showModal();
      node.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (node.open) node.close();
  }, [modal]);
  const modalTitle =
    modal?.kind === "create"
      ? "Name a behavior"
      : modal?.kind === "repair"
        ? "Repair source reference"
        : modal?.kind === "picker"
          ? "Add source to the path"
          : modal?.kind === "delete"
            ? "Delete walkthrough?"
            : modal?.kind === "agent"
              ? "Your agent can use this workspace"
              : modal?.kind === "callback-role"
                ? "Callback source role"
                : "Try the checkout";
  const modalSubtitle =
    modal?.kind === "create"
      ? "What do you want to understand?"
      : modal?.kind === "repair"
        ? "Choose replacement source. Old explanations remain unreviewed until you review each separately."
        : modal?.kind === "picker"
          ? "Choose a symbol or an exact range of lines. HTTP and callback connections can be added explicitly."
          : modal?.kind === "delete"
            ? "This cannot be undone."
            : modal?.kind === "agent"
              ? "The agent reads and edits the same paths and notes you see here."
              : modal?.kind === "callback-role"
                ? "Label this card's source, not runtime execution."
                : "Real React execution with the " +
                  config.backend +
                  " backend. Close this window after “Run captured” appears.";

  return (
    <dialog
      id="modal"
      ref={dialog}
      aria-labelledby="modal-title"
      aria-describedby="modal-subtitle"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onClose={() => {
        close();
        void refresh();
      }}
    >
      <header>
        <div>
          <h2 id="modal-title">{modalTitle}</h2>
          <p id="modal-subtitle">{modalSubtitle}</p>
        </div>
        <button id="close-modal" aria-label="Close" onClick={() => close()}>
          ×
        </button>
      </header>
      <div id="modal-body">
        {error && modal && (
          <p id="modal-error" role="alert" className="source-error">
            {error}
          </p>
        )}
        {modal?.kind === "create" && <CreateForm create={create} />}
        {modal?.kind === "picker" && overview && (
          <Picker
            overview={overview}
            file={modal.file}
            add={addSource}
            fail={fail}
          />
        )}
        {modal?.kind === "repair" && overview && (
          <Picker
            overview={overview}
            requireReview
            add={async (source, _title, fileHash) => {
              if (!fileHash) return fail("Preview source before confirming.");
              await repairSource(modal.target, modal.stepId, source, fileHash);
            }}
            fail={fail}
          />
        )}
        {modal?.kind === "delete" && (
          <DeleteConfirmation
            key={modal.target.id + ":" + modal.target.revision}
            target={modal.target}
            runs={modal.runs}
            remove={() => removePath(modal.target)}
            review={() => void openDelete(modal.target.id)}
          />
        )}
        {modal?.kind === "callback-role" && (
          <CallbackRoleEditor
            key={
              modal.target.id +
              ":" +
              modal.target.revision +
              ":" +
              modal.step.id
            }
            target={modal.target}
            step={modal.step}
            save={saveCallbackRole}
            review={() => void openCallbackRole(modal.step.id, modal.target.id)}
            close={close}
          />
        )}
        {modal?.kind === "agent" && <AgentInstructions fail={fail} />}
        {modal?.kind === "demo" && (
          <iframe className="demo-frame" title="Checkout example" src="/demo" />
        )}
      </div>
    </dialog>
  );
}
