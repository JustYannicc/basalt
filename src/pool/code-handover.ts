import { Schema } from "effect";
import { ControllerCode, sameControllerCode } from "./runtime-slots/contract.ts";
import { nativeRuntimeUnavailable } from "./runtime-unavailable.ts";

/**
 * How long the controller waits for its in-flight model streams before it takes new code anyway.
 * From the pool's own record, 7 days to 21 Nov (115,770 model calls, mostly the daily use before
 * 19 Nov): p99 39 s, p99.9 128 s, max 241 s, and 20 calls over 180 s. So a stream longer than this
 * is cut, about 1 in 5,800. It stays well inside the 300 s the platform waited before resetting the
 * object on its own (twice on 21 Nov) and inside the release's 330 s adoption allowance. Reset it
 * from real traffic once the pool serves daily use again.
 */
export const codeHandoverDrainMs = 180_000;
/** The answer a model call gets while the controller hands over; the entrypoint re-sends on it. */
export const codeHandoverHeader = "X-Signalbox-Pool-Handover";
const pollMs = 250;
/**
 * A recorded handover keeps a new instance that still runs the old code from draining again: the
 * platform hasn't served it the new version yet. Past this, the record no longer counts.
 */
const recordTtlMs = 15 * 60_000;
const recordKey = "pool-code-handover-v1";
const HandoverRecord = Schema.Struct({
  from: ControllerCode,
  to: ControllerCode,
  at: Schema.Number,
});
type EndReason = "drained" | "bound";

/** The adoption read's code, or nothing when it isn't one. */
export const decodeControllerCode = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(ControllerCode)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/** The retryable answer clients already follow; nothing was sent, so a re-send starts nothing twice. */
export function handoverRefusal(request: Request) {
  const response = nativeRuntimeUnavailable(request);
  response.headers.set(codeHandoverHeader, "draining");
  return response;
}

/** A refusal from a controller handing over, which the entrypoint may send again shortly. */
export const handingOver = (response: Response) =>
  response.status === 503 && response.headers.get(codeHandoverHeader) === "draining";

interface Dependencies {
  own: ControllerCode;
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  /** Model requests in flight on this object: exactly what a reset of it would cut. */
  inFlight(): number;
  /** Resets this object so its next event runs the deployed code; the container keeps running. */
  abort(reason: string): void;
  defer(work: Promise<unknown>): void;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  boundMs?: number;
}

/**
 * Hands the controller over to newly deployed code without cutting a model stream. The new
 * entrypoint's signed adoption read names its code; when that differs from this object's own, the
 * object stops admitting new model calls, waits for those in flight within the bound, records the
 * handover, and resets itself. Without this the platform resets it unannounced minutes later and
 * cuts whatever is in flight.
 */
export class CodeHandover {
  private deps: Dependencies;
  private started?: number;
  private starting = false;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private bound() {
    return this.deps.boundMs ?? codeHandoverDrainMs;
  }
  /** While true, new model calls are refused before they take a stream lease. */
  get draining() {
    // In memory only, and it ends by itself a little past the bound even if the reset never came.
    return this.started !== undefined && this.now() - this.started < this.bound() + 5_000;
  }
  /** The deployed entrypoint's code, from its signed adoption read only. Idempotent. */
  offer(caller: ControllerCode) {
    if (sameControllerCode(caller, this.deps.own) || this.starting || this.draining) return;
    this.starting = true;
    this.deps.defer(
      this.begin(caller).finally(() => {
        this.starting = false;
      }),
    );
  }
  private async begin(to: ControllerCode) {
    const raw = await this.deps.storage.get(recordKey);
    const record = raw === undefined ? undefined : Schema.decodeUnknownOption(HandoverRecord)(raw);
    if (
      record?._tag === "Some" &&
      sameControllerCode(record.value.from, this.deps.own) &&
      sameControllerCode(record.value.to, to) &&
      this.now() - record.value.at < recordTtlMs
    ) {
      console.info("POOL_CODE_HANDOVER", { outcome: "waiting_for_platform" });
      return;
    }
    const startedAt = this.now();
    this.started = startedAt;
    const atStart = this.deps.inFlight();
    const wait = this.deps.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    while (this.deps.inFlight() > 0 && this.now() - startedAt < this.bound()) await wait(pollMs);
    const remaining = this.deps.inFlight();
    const reason: EndReason = remaining === 0 ? "drained" : "bound";
    await this.deps.storage.put(recordKey, { from: this.deps.own, to, at: this.now() });
    console.info("POOL_CODE_HANDOVER", {
      outcome: "handing_over",
      reason,
      inFlightAtStart: atStart,
      remaining,
      waitedMs: this.now() - startedAt,
    });
    this.deps.abort("code handover");
  }
}
