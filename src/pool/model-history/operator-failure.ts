const identifier = "[a-z_][a-z0-9_]{0,62}";
const deniedResource = new RegExp(
  `^(?:permission denied for|must be owner of) (table|relation|schema) "?(${identifier})"?$`,
);
const connectionCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/** Driver messages and nested causes may contain connection strings, SQL values or credentials. */
export function historyApplyFailure(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && connectionCodes.has(code))
    return { type: "ConnectionError", code };
  if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) {
    const denied = error instanceof Error ? deniedResource.exec(error.message) : null;
    return {
      type: "PostgresError",
      code,
      ...(denied === null ? {} : { resource: { kind: denied[1], name: denied[2] } }),
    };
  }
  if (error instanceof Error) {
    if (error.message === "Model history database is unavailable")
      return { type: "HistoryDatabaseUnavailable" };
    if (error.message === "Model history database deadline exceeded")
      return { type: "HistoryDatabaseDeadline" };
    if (error instanceof TypeError) return { type: "TypeError" };
    if (error instanceof RangeError) return { type: "RangeError" };
  }
  return { type: "UnknownError" };
}
