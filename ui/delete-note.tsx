import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../types.mjs";

// Independent of source review/editor drafts. The caller closes over exactly the
// scope and revision rendered when the human opens confirmation.
export function DeleteNoteAction({
  remove,
  current = () => true,
}: {
  remove: () => Promise<unknown>;
  current?: () => boolean;
}) {
  type Confirmation = {
    instance: symbol;
    remove: () => Promise<unknown>;
    current: () => boolean;
  };
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const owner = useRef<Confirmation | null>(null);
  useEffect(
    () => () => {
      owner.current = null;
    },
    []
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const authorized = () =>
    owner.current === confirmation && !!confirmation?.current();
  return confirmation && authorized() ? (
    <div className="delete-note-confirm">
      <p>
        Remove this active entry? Its identity and history will remain stored.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void confirmation
            .remove()
            .then(() => {
              if (authorized()) setConfirmation(null);
            })
            .catch((error: unknown) => {
              if (authorized()) setError(errorMessage(error));
            })
            .finally(() => {
              if (authorized()) setBusy(false);
            });
        }}
      >
        Confirm delete note
      </button>
      <button
        disabled={busy}
        onClick={() => {
          owner.current = null;
          setConfirmation(null);
          setError("");
        }}
      >
        Cancel
      </button>
    </div>
  ) : (
    <button
      onClick={() => {
        const next = {
          instance: Symbol("delete confirmation"),
          remove,
          current,
        };
        owner.current = next;
        setConfirmation(next);
        setBusy(false);
        setError("");
      }}
    >
      Delete note
    </button>
  );
}
