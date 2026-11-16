// Background reads coalesce. An explicit read must start after any older read
// has drained; cancellation is checked again before taking the single permit.
export function createRefreshQueue() {
  let running: Promise<void> | null = null;
  return async (
    read: () => Promise<void>,
    explicit: boolean,
    current: () => boolean
  ): Promise<void> => {
    if (running && !explicit) return;
    while (running) {
      try {
        await running;
      } catch {
        // Failure belongs to the older caller, not its successor.
      }
    }
    if (!current()) return;
    const operation = Promise.resolve().then(read);
    running = operation;
    try {
      await operation;
    } finally {
      if (running === operation) running = null;
    }
  };
}
