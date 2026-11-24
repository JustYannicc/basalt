import {
  correlateEndpointRequest,
  endpointRequestId,
  runtimeResponseRefusal,
} from "../runtime-route-diagnostic.ts";

export { endpointRequestId, retainEndpointRequestId } from "../runtime-route-diagnostic.ts";

const names = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AbortError",
  "TimeoutError",
  "InvalidStateError",
  "NetworkError",
  "DisconnectedError",
] as const;
const codes = [
  "ABORT_ERR",
  "ERR_DISCONNECTED",
  "ERR_RPC_DISCONNECTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
] as const;
const actions = [
  "/health",
  "/start",
  "/observe",
  "/warm",
  "/admit",
  "/attest",
  "/witness",
  "/ready",
  "/install",
  "/native",
  "/retire",
  "/release-still",
  "/drain",
  "/retirement",
  "/failed",
] as const;
const responses = new WeakMap<Response, EndpointTrace>();
const requests = new WeakMap<Request, EndpointTrace>();
const object = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
function field(error: unknown, key: string): unknown {
  try {
    return object(error) ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
}
function flag(error: unknown, key: string) {
  const value = field(error, key);
  return value === undefined ? null : typeof value === "boolean" ? value : "invalid";
}
/** Closed classes and the platform's own flags, never the exception text. */
export function shape(error: unknown) {
  const name = field(error, "name"),
    code = field(error, "code"),
    message = field(error, "message");
  return {
    name: names.find((value) => value === name) ?? (name === undefined ? null : "other"),
    code:
      codes.find((value) => value === code) ??
      (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 25
        ? code
        : code === undefined
          ? null
          : "other"),
    messageClass:
      typeof message !== "string"
        ? "absent"
        : /no longer active/i.test(message)
          ? "instance_inactive"
          : /was reset/i.test(message)
            ? "object_reset"
            : /connection lost/i.test(message)
              ? "connection_lost"
              : /disconnect|broken.*stub|broken.*capability/i.test(message)
                ? "disconnected"
                : /overload/i.test(message)
                  ? "overloaded"
                  : /abort|cancel/i.test(message)
                    ? "aborted"
                    : /timed?\s*out|deadline/i.test(message)
                      ? "timeout"
                      : /reset|refused|socket|network|transport/i.test(message)
                        ? "transport"
                        : "other",
    isError: error instanceof Error,
    disconnected: flag(error, "disconnected"),
    retryable: flag(error, "retryable"),
    overloaded: flag(error, "overloaded"),
    remote: flag(error, "remote"),
    durableObjectReset: flag(error, "durableObjectReset"),
  };
}
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
    this.logged = true;
    if (object(result)) correlateEndpointRequest(result, this.requestId);
    const path = new URL(this.request.url).pathname;
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
