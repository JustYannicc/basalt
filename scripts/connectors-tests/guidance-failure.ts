const names = new Set([
  "Error",
  "AssertionError",
  "TimeoutError",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TargetClosedError",
  "UnknownError",
]);
const markers = new Set(["missing-executable", "sandbox", "missing-library", "timeout", "other"]);

export const zohoMcpPhases = Object.freeze([
  "zoho-mcp-runtime",
  "zoho-mcp-runtime-restart",
  "zoho-mcp-browser-launch",
  "zoho-mcp-browser-context",
  "zoho-mcp-open-app",
  "zoho-mcp-connect-dialog",
  "zoho-mcp-method",
  "zoho-mcp-endpoint-entry",
  "zoho-mcp-endpoint-validation",
  "zoho-mcp-endpoint-save",
  "zoho-mcp-oauth-ready",
  "zoho-mcp-oauth-consent",
  "zoho-mcp-oauth-callback",
  "zoho-mcp-connected",
  "zoho-mcp-browser-assertions",
  "zoho-mcp-browser-cleanup",
  "zoho-mcp-privacy",
  "zoho-mcp-report",
]);

/** Ignore arbitrary error names and markers at the reporting boundary. */
export function parseClosedErrorClass(text: string) {
  const match = / error=([A-Za-z]+) marker=([a-z-]+)$/.exec(text);
  return match && names.has(match[1]) && markers.has(match[2])
    ? { errorName: match[1], marker: match[2] }
    : undefined;
}

function describeError(value: unknown) {
  if (!(value instanceof Error)) return String(value);
  const code = "code" in value && typeof value.code === "string" ? ` [${value.code}]` : "";
  return `${value.name}${code}: ${value.message}`;
}

/** Stack frames and paths name the checkout directory, so neither may decide the class. */
function classificationText(error: unknown) {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  while (!seen.has(current)) {
    seen.add(current);
    parts.push(describeError(current));
    if (!(current instanceof Error)) break;
    current = current.cause;
    if (!(current instanceof Error) && typeof current !== "string") break;
  }
  return parts.join("\n").replace(/(?:file:\/\/)?\/[^\s'"`)]+/g, "<path>");
}

/** Failure messages can contain connection data; only publicLine may leave the private capture. */
export function describeGuidanceFailure(error: unknown, phase: string) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const text = classificationText(error);
  const failurePhase = [
    "initialization",
    "tenant-public-client",
    "global-client-preference",
    "company-guidance",
    ...zohoMcpPhases,
  ].includes(phase)
    ? phase
    : "initialization";
  const kind = /AssertionError|ERR_ASSERTION/.test(text)
    ? "assertion"
    : /browserType\.launch|Executable doesn't exist|launch:/.test(text)
      ? "browser-launch"
      : /Cannot find module|Cannot find package|ModuleNotFound|SyntaxError/.test(text)
        ? "module-load"
        : /ENOTFOUND|EAI_AGAIN/.test(text)
          ? "dns"
          : /ECONNREFUSED|ECONNRESET/.test(text)
            ? "connection"
            : /EACCES|EPERM/.test(text)
              ? "permission"
              : /[Tt]imeout|[Tt]imed out/.test(text)
                ? "timeout"
                : "runtime";
  const frame =
    /(?:scripts\/connectors-tests\/|e2e\/)((?:zendesk-(?:tenant-runtime|tenant-public|operator-choices|company-guidance)|zoho-people-mcp(?:-ui)?)\.mjs):([1-9]\d{0,5}):\d+\b/.exec(
      detail,
    );
  const location = frame === null ? "unknown" : `${frame[1]}:${frame[2]}`;
  const name = error instanceof Error && names.has(error.name) ? error.name : "UnknownError";
  const marker = /Executable doesn't exist|executable.*(?:not found|does not exist)/i.test(text)
    ? "missing-executable"
    : /No usable sandbox|SUID sandbox|Failed to move to new namespace|unprivileged user namespace|apparmor/i.test(
          text,
        )
      ? "sandbox"
      : /error while loading shared libraries|cannot open shared object file|Host system is missing dependencies|Missing libraries:/i.test(
            text,
          )
        ? "missing-library"
        : /[Tt]imeout|[Tt]imed out/.test(text)
          ? "timeout"
          : "other";
  return {
    privateDetail: detail,
    publicLine: `CONNECTORS_PROOF_FAILURE phase=${failurePhase} kind=${kind} at=${location} error=${name} marker=${marker}`,
  };
}
