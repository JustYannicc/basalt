import { ControlFailure } from "../json.ts";

export type HistoryTimeoutReason =
  | "total_deadline"
  | "statement_timeout"
  | "lock_timeout"
  | "query_timeout"
  | "connect_timeout"
  | "cancelled";

export class HistoryTimeoutFailure extends ControlFailure {
  readonly reason: HistoryTimeoutReason;

  constructor(reason: HistoryTimeoutReason) {
    super(504, "history_timeout", "History is taking too long. Try again.");
    this.reason = reason;
  }
}

/**
 * A summary window holding more requests than one bounded read can aggregate. Refused before any
 * aggregate statement runs, so a page load costs a bounded index count instead of a 5 s scan.
 */
export class HistoryTooLarge extends ControlFailure {
  constructor() {
    super(
      503,
      "history_too_large",
      "This pool's usage history is too large to summarize in one read yet.",
    );
  }
}

export function historyTimeoutReason(error: unknown): HistoryTimeoutReason | undefined {
  if (error instanceof HistoryTimeoutFailure) return error.reason;
  if (typeof error !== "object" || error === null) return;
  const code = "code" in error ? error.code : undefined;
  if (code === "57014") return "statement_timeout";
  if (code === "55P03") return "lock_timeout";
  if (code === "ETIMEDOUT") return "connect_timeout";
  if (error instanceof Error) {
    if (error.message === "Query read timeout") return "query_timeout";
    if (
      error.message === "timeout expired" ||
      error.message === "Connection terminated due to connection timeout"
    )
      return "connect_timeout";
    if (error.name === "AbortError") return "cancelled";
    if (error.name === "TimeoutError") return "query_timeout";
  }
}

/** A single deadline also cancels callbacks waiting outside the database driver. */
export class HistoryDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expiry: Promise<never>;
  private rejectExpiry: (error: HistoryTimeoutFailure) => void = () => {};
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly onStop: (() => void) | undefined;
  private failure?: HistoryTimeoutFailure;
  private readonly abort = () =>
    this.stop(
      this.parentSignal?.reason instanceof HistoryTimeoutFailure
        ? this.parentSignal.reason
        : new HistoryTimeoutFailure("cancelled"),
    );

  constructor(timeoutMs: number, parentSignal?: AbortSignal, onStop?: () => void) {
    this.parentSignal = parentSignal;
    this.onStop = onStop;
    this.signal = this.controller.signal;
    this.expiry = new Promise<never>((_resolve, reject) => {
      this.rejectExpiry = reject;
    });
    // An already-cancelled request can expire before its first operation starts.
    void this.expiry.catch(() => {});
    this.timer = setTimeout(
      () => this.stop(new HistoryTimeoutFailure("total_deadline")),
      timeoutMs,
    );
    parentSignal?.addEventListener("abort", this.abort, { once: true });
    if (parentSignal?.aborted) this.abort();
  }

  check(): void {
    if (this.failure) throw this.failure;
  }

  stop(error: HistoryTimeoutFailure): void {
    if (this.failure) return;
    this.failure = error;
    this.controller.abort(error);
    try {
      this.onStop?.();
    } catch {
      /* Closing an already-closed socket cannot change the timeout response. */
    }
    this.rejectExpiry(error);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    return Promise.race([
      this.expiry,
      Promise.resolve().then(() => {
        this.check();
        return work();
      }),
    ]);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener("abort", this.abort);
  }
}
