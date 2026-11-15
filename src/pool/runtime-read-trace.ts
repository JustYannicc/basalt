export type RuntimeReadPhase =
  | "configuration"
  | "identity"
  | "health_headers"
  | "health_body"
  | "health_identity"
  | "request_prepare"
  | "port_headers";

type RuntimeReadPort = 8318 | 8327 | 8329;
let sequence = 0;

/** Emit before awaiting: even a tunnel that ignores cancellation leaves its pending phase. */
export class RuntimeReadTrace {
  private read = ++sequence;
  private started = performance.now();
  private signal: AbortSignal;
  constructor(signal: AbortSignal) {
    this.signal = signal;
  }

  async run<T>(phase: RuntimeReadPhase, work: () => Promise<T>, port?: RuntimeReadPort) {
    const started = performance.now();
    const emit = (outcome: "started" | "pending" | "aborted" | "ok" | "error") =>
      console.info("POOL_RUNTIME_READ", {
        read: this.read,
        phase,
        outcome,
        callerAborted: this.signal.aborted,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        readElapsedMs: Math.max(0, Math.round(performance.now() - this.started)),
        ...(port === undefined ? {} : { port }),
      });
    const aborted = () => emit("aborted");
    this.signal.addEventListener("abort", aborted, { once: true });
    const pending = setTimeout(() => emit("pending"), 1_000);
    emit("started");
    try {
      const value = await work();
      emit("ok");
      return value;
    } catch (error) {
      emit("error");
      throw error;
    } finally {
      clearTimeout(pending);
      this.signal.removeEventListener("abort", aborted);
    }
  }
}

export function runtimeReadStep<T>(
  trace: RuntimeReadTrace | undefined,
  phase: RuntimeReadPhase,
  work: () => Promise<T>,
  port?: RuntimeReadPort,
) {
  return trace ? trace.run(phase, work, port) : work();
}
