import { untilAborted } from "../connection/abort.ts";

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
  let notBefore = 0;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    timer = setTimeout(
      () => {
        void request();
      },
      Math.min(2_147_483_647, Math.max(1, delay)),
    );
  };
  const request = (manual = false): Promise<void> => {
    if (!ports.allowed() || (!manual && ports.terminal())) return Promise.resolve();
    clear();
    if (pending) return controller?.signal.aborted ? pending.then(() => request(manual)) : pending;
    needed = true;
    if (notBefore > Date.now()) {
      schedule(notBefore - Date.now());
      return Promise.resolve();
    }
    controller = new AbortController();
    const current = controller;
    const signal = current.signal;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      current.abort(new Error("Reconnect timed out."));
    }, 12_000);
    ports.changed(true);
    pending = (async () => {
      try {
        await untilAborted(ports.attempt(signal), signal);
        signal.throwIfAborted();
        needed = false;
        failures = 0;
        notBefore = 0;
        ports.changed(false);
      } catch {
        if (signal.aborted && !timedOut) return;
        needed = !ports.terminal();
        ports.changed(
          needed,
          needed
            ? "Connection interrupted. Retrying automatically."
            : "Sign in again to reconnect this phone.",
        );
      } finally {
        clearTimeout(deadline);
        pending = undefined;
        controller = undefined;
        if ((!signal.aborted || timedOut) && needed && ports.allowed() && !ports.terminal()) {
          const ceiling = Math.min(5_000, 1000 * 2 ** Math.min(failures++, 5));
          const delay = Math.round(ceiling * (0.5 + ports.random() * 0.5));
          schedule(Math.max(delay, notBefore - Date.now()));
        }
      }
    })();
    return pending;
  };
  return {
    request,
    restart: async () => {
      if (!ports.allowed() || ports.terminal()) return;
      clear();
      controller?.abort();
      await pending;
      await request();
    },
    reset: () => {
      notBefore = 0;
      failures = 0;
      needed = false;
    },
    retryAfter: (timestamp: number) => {
      notBefore = Math.max(notBefore, timestamp);
    },
    needed: () => needed,
    running: () => pending !== undefined,
    stop: async () => {
      clear();
      controller?.abort();
      await pending;
    },
  };
}
