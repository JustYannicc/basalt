/**
 * The closed shape of an error a hop saw, for logs: its class, code and message class, and the
 * platform's own flags, never the exception text. It imports nothing, so the router can log what
 * its pool binding threw without loading the pool's runtime contracts.
 */
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
  // An argument an RPC call can't send, such as a Request carrying an AbortSignal.
  "DataCloneError",
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
export const object = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
export function field(error: unknown, key: string): unknown {
  try {
    return object(error) ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
}
export function flag(error: unknown, key: string) {
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
