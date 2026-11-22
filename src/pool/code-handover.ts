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
/** How long refusals outlast the reset call, in case the platform doesn't reset the object. */
const graceMs = 5_000;
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

/**
 * Finite model calls on this object, counted from the moment they pass the handover's refusal
 * until their answer ends, errors or is cancelled. Counting starts before any await, so no call
 * slips past the check uncounted. Model sockets are left out: they stay open for hours, the reset
 * closes them and their clients reconnect, so counting them would hold every drain to its bound.
 */
export class HandoverCount {
  active = 0;
  track(request: Request, work: () => Promise<Response>): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return work();
    this.active++;
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      this.active--;
    };
    // A caller that leaves never reads its answer, so the call ends with it.
    request.signal.addEventListener("abort", end, { once: true });
    let pending: Promise<Response>;
    try {
      pending = work();
    } catch (error) {
      end();
      throw error;
    }
    return pending.then(
      (response) => untilEnded(response, end),
      (error: unknown) => {
        end();
        throw error;
      },
    );
  }
}

function untilEnded(response: Response, end: () => void) {
  if (!response.body || response.status === 101) {
    end();
    return response;
  }
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (!part.done) return controller.enqueue(part.value);
          end();
          controller.close();
        } catch (error) {
          end();
          controller.error(error);
        }
      },
      async cancel(reason) {
        end();
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

interface Dependencies {
  own: ControllerCode;
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  /** Finite model calls admitted on this object (HandoverCount). Sockets are left out. */
  inFlight(): number;
  /** Object work a reset would cut halfway, such as an alarm pass, a Home pass or a handoff. */
  busy?(): boolean;
  /** Resets this object so its next event runs the deployed code. */
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
  private ended?: number;
  private starting = false;
  /** The code this instance already found recorded, so its later adoption reads stay quiet. */
  private waitingFor?: ControllerCode;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private bound() {
    return this.deps.boundMs ?? codeHandoverDrainMs;
  }
  /** While true, new model calls are refused before they are counted. */
  get draining() {
    // In memory only. It ends by itself shortly after the reset call even if no reset came.
    if (this.started === undefined) return false;
    return this.now() < (this.ended ?? this.started + this.bound()) + graceMs;
  }
  /** The deployed entrypoint's code, from its signed adoption read only. Idempotent. */
  offer(caller: ControllerCode) {
    if (
      sameControllerCode(caller, this.deps.own) ||
      (this.waitingFor !== undefined && sameControllerCode(caller, this.waitingFor)) ||
      this.starting ||
      this.draining
    )
      return;
    this.starting = true;
    this.deps.defer(
      this.begin(caller).finally(() => {
        this.starting = false;
      }),
    );
  }
  private async begin(to: ControllerCode) {
    const own = this.deps.own;
    const raw = await this.deps.storage.get(recordKey);
    const record = raw === undefined ? undefined : Schema.decodeUnknownOption(HandoverRecord)(raw);
    if (
      record?._tag === "Some" &&
      sameControllerCode(record.value.from, own) &&
      sameControllerCode(record.value.to, to) &&
      this.now() - record.value.at < recordTtlMs
    ) {
      this.waitingFor = to;
      console.info("POOL_CODE_HANDOVER", { outcome: "waiting_for_platform", from: own, to });
      return;
    }
    const startedAt = this.now();
    this.started = startedAt;
    this.ended = undefined;
    let atStart = 0,
      remaining = 0,
      busy = false;
    try {
      atStart = this.deps.inFlight();
      // Written first, so nothing is awaited between the last idle check and the reset. It only
      // keeps a new instance on the old code from draining again, so losing it costs at most a
      // second drain and the handover goes ahead without it.
      await this.deps.storage
        .put(recordKey, { from: own, to, at: startedAt })
        .catch(() => console.error("POOL_CODE_HANDOVER_RECORD_PENDING"));
      const wait = this.deps.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
      const pending = () => this.deps.inFlight() > 0 || this.deps.busy?.() === true;
      while (pending() && this.now() - startedAt < this.bound()) await wait(pollMs);
      remaining = this.deps.inFlight();
      busy = this.deps.busy?.() === true;
    } catch (error) {
      this.started = undefined;
      throw error;
    }
    const reason: EndReason = remaining === 0 && !busy ? "drained" : "bound";
    this.ended = this.now();
    console.info("POOL_CODE_HANDOVER", {
      outcome: "handing_over",
      reason,
      inFlightAtStart: atStart,
      remaining,
      busy,
      startedAt,
      waitedMs: this.ended - startedAt,
      from: own,
      to,
    });
    try {
      this.deps.abort("code handover");
    } catch {
      // A reset that throws still ends this instance; the refusals end within graceMs either way.
    }
  }
}
