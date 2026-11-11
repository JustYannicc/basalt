/** Bound connection setup work; an open response stream no longer occupies a start slot. */
export class StartQueue {
  private active = 0;
  private waiting = new Set<() => void>();

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= 32) {
      if (this.waiting.size >= 1024)
        throw new Error("The connection start queue is full; no request was dispatched.");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.waiting.delete(ready);
        };
        const ready = () => {
          cleanup();
          this.active++;
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("The connection start queue timed out before dispatch."));
        }, 30_000);
        this.waiting.add(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.values().next().value?.();
    };
  }
}
