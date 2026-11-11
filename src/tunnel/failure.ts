const names = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "InvalidStateError",
  "DataCloneError",
  "OperationError",
  "NotSupportedError",
  "SecurityError",
  "UnknownError",
]);
const codes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_INVALID_STATE",
  "ERR_STREAM_DESTROYED",
  "ERR_WEBSOCKET_CLOSED",
  "ERR_WEBSOCKET_CONNECTION_ERROR",
]);
type Phase = "message" | "flush" | "socket" | "http";
type EventKind = "message" | "close" | "error";

function field(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Exception names and codes can contain peer input; only known identifiers leave the boundary. */
export function tunnelFailure(error: unknown, phase: Phase, event: EventKind) {
  const className = field(field(error, "constructor"), "name");
  const name = field(error, "name");
  const code = field(error, "code");
  return {
    class: typeof className === "string" && names.has(className) ? className : "unknown",
    name: typeof name === "string" && names.has(name) ? name : "unknown",
    code:
      typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 65535
        ? code
        : typeof code === "string"
          ? codes.has(code)
            ? code
            : "other"
          : null,
    phase,
    event,
  };
}
export type TunnelFailure = ReturnType<typeof tunnelFailure>;

export function recordTunnelFailure(id: number, failure: TunnelFailure) {
  console.warn("NATIVE_TUNNEL_FAILURE " + JSON.stringify({ id, ...failure }));
}
