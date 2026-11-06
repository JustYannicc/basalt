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

/** Ignore arbitrary error names and markers at the reporting boundary. */
export function parseClosedErrorClass(text) {
  const match = / error=([A-Za-z]+) marker=([a-z-]+)$/.exec(text);
  return match && names.has(match[1]) && markers.has(match[2])
    ? { errorName: match[1], marker: match[2] }
    : undefined;
}

/** Failure messages can contain connection data; only publicLine may leave the private capture. */
export function describeGuidanceFailure(error, phase) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const failurePhase = [
    "initialization",
    "tenant-public-client",
    "global-client-preference",
    "company-guidance",
  ].includes(phase)
    ? phase
    : "initialization";
  const kind = /AssertionError|ERR_ASSERTION/.test(detail)
    ? "assertion"
    : /browserType\.launch|Executable doesn't exist|launch:/.test(detail)
      ? "browser-launch"
      : /Cannot find module|Cannot find package|ModuleNotFound|SyntaxError/.test(detail)
        ? "module-load"
        : /ENOTFOUND|EAI_AGAIN/.test(detail)
          ? "dns"
          : /ECONNREFUSED|ECONNRESET/.test(detail)
            ? "connection"
            : /EACCES|EPERM/.test(detail)
              ? "permission"
              : /[Tt]imeout|[Tt]imed out/.test(detail)
                ? "timeout"
                : "runtime";
  const frame =
    /scripts\/connectors-tests\/(zendesk-(?:tenant-runtime|tenant-public|operator-choices|company-guidance)\.mjs):([1-9]\d{0,5}):\d+\b/.exec(
      detail,
    );
  const location = frame === null ? "unknown" : `${frame[1]}:${frame[2]}`;
  const name = error instanceof Error && names.has(error.name) ? error.name : "UnknownError";
  const marker = /Executable doesn't exist|executable.*(?:not found|does not exist)/i.test(detail)
    ? "missing-executable"
    : /No usable sandbox|SUID sandbox|Failed to move to new namespace|unprivileged user namespace|apparmor/i.test(
          detail,
        )
      ? "sandbox"
      : /error while loading shared libraries|cannot open shared object file|Host system is missing dependencies|Missing libraries:/i.test(
            detail,
          )
        ? "missing-library"
        : name === "TimeoutError" || /[Tt]imeout|[Tt]imed out/.test(detail)
          ? "timeout"
          : "other";
  return {
    privateDetail: detail,
    publicLine: `CONNECTORS_PROOF_FAILURE phase=${failurePhase} kind=${kind} at=${location} error=${name} marker=${marker}`,
  };
}
