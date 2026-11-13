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
  "/drain",
  "/retirement",
  "/failed",
] as const;
const correlations = new WeakMap<object, string>();
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
function shape(error: unknown) {
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
  };
}
interface Attempt {
  attempt: number;
  stub: number;
  outcome: "pending" | "response" | "error";
  status?: number;
  error?: ReturnType<typeof shape>;
}

export function endpointRequestId(error: unknown) {
  return object(error) ? correlations.get(error) : undefined;
}
export function failEndpointResponse(response: Response, error: unknown) {
  responses.get(response)?.finish(error);
}
export function retainEndpointRequestId(source: object, destination: object) {
  const id = correlations.get(source);
  if (id) correlations.set(destination, id);
}

/** One bounded record preserves both attempts without copying exception text or request data. */
export class EndpointTrace {
  private attempts: Attempt[] = [];
  private request: Request;
  private slotId: string;
  private cellId: string;
  private requestId = crypto.randomUUID();
  private logged = false;
  eligible = false;
  reconnected = false;
  reconnectAcquired = false;
  constructor(request: Request, slotId: string, cellId: string) {
    this.request = request;
    this.slotId = slotId;
    this.cellId = cellId;
  }
  static forRequest(request: Request, slotId: string, cellId: string) {
    const retained = requests.get(request);
    if (retained) {
      retained.cellId = cellId;
      return retained;
    }
    const trace = new EndpointTrace(request, slotId, cellId);
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
    try {
      const response = await work();
      this.attempts[attempt - 1] = { attempt, stub, outcome: "response", status: response.status };
      return response;
    } catch (error) {
      this.attempts[attempt - 1] = { attempt, stub, outcome: "error", error: shape(error) };
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
    if (object(result) && correlations.has(result) && correlations.get(result) !== this.requestId)
      return;
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
      if (object(result)) correlations.set(result, this.requestId);
      return;
    }
    if (
      result instanceof Response &&
      !failedResponse &&
      !this.attempts.some((attempt) => attempt.outcome === "error")
    )
      return;
    this.logged = true;
    if (object(result)) correlations.set(result, this.requestId);
    const path = new URL(this.request.url).pathname;
    console.error(
      "POOL_RUNTIME_ENDPOINT_FAILURE",
      JSON.stringify({
        requestId: this.requestId,
        slotId: this.slotId,
        cellId: this.cellId,
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
        attempts: this.attempts,
      }),
    );
  }
}
