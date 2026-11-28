import {
  correlateEndpointRequest,
  endpointRequestId,
  runtimeResponseRefusal,
} from "../runtime-route-diagnostic.ts";

export { endpointRequestId, retainEndpointRequestId } from "../runtime-route-diagnostic.ts";
import { field, object, shape } from "../error-shape.ts";
export { shape } from "../error-shape.ts";

const actions = [
  "/health",
  "/start",
  "/observe",
  "/warm",
  "/admit",
  "/attest",
  "/witness",
  "/attestation",
  "/ready",
  "/install",
  "/native",
  "/retire",
  "/release-still",
  "/release-check",
  "/drain",
  "/retirement",
  "/failed",
] as const;
const responses = new WeakMap<Response, EndpointTrace>();
const requests = new WeakMap<Request, EndpointTrace>();
interface Attempt {
  attempt: number;
  stub: number;
  outcome: "pending" | "response" | "error";
  status?: number;
  elapsedMs?: number;
  refusal?: ReturnType<typeof runtimeResponseRefusal>;
  error?: ReturnType<typeof shape>;
}
const elapsed = (started: number) =>
  Math.max(0, Math.min(86_400_000, Math.round(performance.now() - started)));
const boot = (value: unknown) =>
  typeof value === "string" && /^[\w.:-]{1,128}$/u.test(value) ? value : undefined;
/** A forward names its runtime in the identity header; a control call passes it instead. */
function headerBoot(request: Request) {
  const header = request.headers.get("X-Signalbox-Runtime-Identity");
  if (header === null || header.length > 4096) return undefined;
  try {
    const value: unknown = JSON.parse(header);
    return object(value) ? boot(field(value, "bootId")) : undefined;
  } catch {
    return undefined;
  }
}

export function failEndpointResponse(response: Response, error: unknown) {
  responses.get(response)?.finish(error);
}

/** One bounded record preserves both attempts without copying exception text or request data. */
export class EndpointTrace {
  private attempts: Attempt[] = [];
  private started: number[] = [];
  private request: Request;
  private slotId: string;
  private cellId: string;
  // The boot a call was sent to, so a failure joins the exact process, not only its slot.
  private bootId: string | undefined;
  private requestId = crypto.randomUUID();
  private logged = false;
  eligible = false;
  reconnected = false;
  reconnectAcquired = false;
  constructor(request: Request, slotId: string, cellId: string, bootId?: string) {
    this.request = request;
    this.slotId = slotId;
    this.cellId = cellId;
    this.bootId = boot(bootId) ?? headerBoot(request);
  }
  static forRequest(request: Request, slotId: string, cellId: string, bootId?: string) {
    const retained = requests.get(request);
    if (retained) {
      retained.cellId = cellId;
      retained.bootId ??= boot(bootId);
      return retained;
    }
    const trace = new EndpointTrace(request, slotId, cellId, bootId);
    requests.set(request, trace);
    return trace;
  }
  driverSend(stub: number, work: () => Promise<Response>) {
    const before = this.attempts.length;
    let pending: Promise<Response>;
    try {
      pending = work();
    } catch (error) {
      return this.send(stub, async () => {
        throw error;
      });
    }
    // A fleet wrapper records its actual endpoint sends synchronously before yielding.
    return this.attempts.length === before ? this.send(stub, () => pending) : pending;
  }
  async send(stub: number, work: () => Promise<Response>) {
    const attempt = this.attempts.length + 1;
    this.attempts.push({ attempt, stub, outcome: "pending" });
    const started = performance.now();
    this.started[attempt - 1] = started;
    try {
      const response = await work();
      // A 500 defect also carries step and reason headers; only a 409 is a refusal.
      const refusal = response.status === 409 ? runtimeResponseRefusal(response) : undefined;
      this.attempts[attempt - 1] = {
        attempt,
        stub,
        outcome: "response",
        status: response.status,
        elapsedMs: elapsed(started),
        ...(refusal ? { refusal } : {}),
      };
      return response;
    } catch (error) {
      this.attempts[attempt - 1] = {
        attempt,
        stub,
        outcome: "error",
        elapsedMs: elapsed(started),
        error: shape(error),
      };
      throw error;
    }
  }
  private reconnectOutcome() {
    if (!this.reconnected)
      return this.eligible && this.request.signal.aborted ? "aborted" : "not_run";
    if (!this.reconnectAcquired) return "acquisition_error";
    const repeated = this.attempts[1];
    if (!repeated) return "pending";
    if (repeated.outcome === "response")
      return (repeated.status ?? 0) >= 400 ? "refusal" : "response";
    return repeated.outcome;
  }
  finish(result: unknown) {
    const correlated = endpointRequestId(result);
    if (correlated !== undefined && correlated !== this.requestId) return;
    if (result instanceof Response) {
      if (responses.has(result) && responses.get(result) !== this) return;
      responses.set(result, this);
    }
    const failedResponse =
      result instanceof Response &&
      !result.ok &&
      (!this.request.headers.has("X-Signalbox-Runtime-Identity") ||
        result.headers.has("X-Signalbox-Runtime-Failure-Step"));
    if (this.logged) {
      if (object(result)) correlateEndpointRequest(result, this.requestId);
      return;
    }
    if (
      result instanceof Response &&
      !failedResponse &&
      !this.attempts.some((attempt) => attempt.outcome === "error")
    )
      return;
    const path = new URL(this.request.url).pathname;
    // A health read its own caller deliberately aborted, as the guard's probe does at its deadline,
    // is that caller's to report: the guard keeps its own outcome and elapsed time. It is decided on
    // the abort's reason, so the outcome doesn't depend on which promise settles first: a timeout
    // signal's reason is a TimeoutError and always logs, and so does a send that failed first.
    const reason: unknown = this.request.signal.reason;
    if (
      path === "/health" &&
      !(result instanceof Response) &&
      this.request.signal.aborted &&
      reason instanceof DOMException &&
      reason.name === "AbortError" &&
      this.attempts.every(
        (attempt) =>
          attempt.outcome === "pending" ||
          (attempt.outcome === "error" && attempt.error?.name === "AbortError"),
      )
    )
      return;
    this.logged = true;
    if (object(result)) correlateEndpointRequest(result, this.requestId);
    console.error(
      "POOL_RUNTIME_ENDPOINT_FAILURE",
      JSON.stringify({
        requestId: this.requestId,
        slotId: this.slotId,
        cellId: this.cellId,
        bootId: this.bootId ?? null,
        method:
          ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].find(
            (method) => method === this.request.method,
          ) ?? "other",
        path: actions.find((action) => action === path) ?? "other",
        identityHeaderPresent: this.request.headers.has("X-Signalbox-Runtime-Identity"),
        reconnectEligible: this.eligible,
        reconnectRan: this.reconnected,
        reconnectAcquired: this.reconnectAcquired,
        reconnectOutcome: this.reconnectOutcome(),
        terminalError: result instanceof Response ? null : shape(result),
        signalAborted: this.request.signal.aborted,
        // A send still pending when the caller gave up reports how long it had waited so far.
        attempts: this.attempts.map((attempt, index) =>
          attempt.outcome === "pending"
            ? { ...attempt, elapsedMs: elapsed(this.started[index] ?? performance.now()) }
            : attempt,
        ),
      }),
    );
  }
}
