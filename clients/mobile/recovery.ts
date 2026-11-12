/** Retries grant validation only. Application operations never enter this loop. */
export function reconnectRecovery(ports: {
  allowed(): boolean;
  terminal(): boolean;
  attempt(signal: AbortSignal): Promise<void>;
  changed(reconnecting: boolean, error?: string): void;
  random(): number;
}) {
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needed = false;
  let failures = 0;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const request = (manual = false): Promise<void> => {
    if (!ports.allowed() || (!manual && ports.terminal())) return Promise.resolve();
    clear();
    if (pending) {
      // Resume can arrive before the background cancellation has settled.
      return controller?.signal.aborted ? pending.then(() => request(manual)) : pending;
    }
    needed = true;
    controller = new AbortController();
    const signal = controller.signal;
    ports.changed(true);
    pending = (async () => {
      try {
        await ports.attempt(signal);
        signal.throwIfAborted();
        needed = false;
        failures = 0;
        ports.changed(false);
      } catch {
        if (signal.aborted) return;
        needed = !ports.terminal();
        ports.changed(
          needed,
          needed
            ? "Connection interrupted. Retrying automatically."
            : "Sign in again to reconnect this phone.",
        );
      } finally {
        pending = undefined;
        controller = undefined;
        if (!signal.aborted && needed && ports.allowed() && !ports.terminal()) {
          const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
          const delay = Math.round(ceiling * (0.5 + ports.random() * 0.5));
          timer = setTimeout(() => {
            void request();
          }, delay);
        }
      }
    })();
    return pending;
  };
  return {
    request,
    needed: () => needed,
    running: () => pending !== undefined,
    stop: async () => {
      clear();
      controller?.abort();
      await pending;
    },
  };
}
