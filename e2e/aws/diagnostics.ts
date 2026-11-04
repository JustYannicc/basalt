const phases = new Set([
  "unknown",
  "module-load",
  "fixture",
  "environment",
  "registry",
  "framework",
  "server",
  "actors",
  "deploy",
  "inventory",
  "access",
  "oauth",
  "health",
  "mcp-keys",
  "mcp-connect",
  "tools",
  "browser",
  "paste-ui",
  "refresh",
  "report",
]);

const kinds = new Set([
  "timeout",
  "module-resolution",
  "assertion",
  "syntax",
  "type",
  "browser-launch",
  "unknown",
]);

function failureKind(text: string) {
  if (/browserType\.launch|Socket path too long|Failed to create socket directory/.test(text))
    return "browser-launch";
  if (/(?:Cannot find (?:package|module)|ModuleNotFound|ERR_MODULE_NOT_FOUND)/.test(text))
    return "module-resolution";
  if (/AssertionError/.test(text)) return "assertion";
  if (/SyntaxError/.test(text)) return "syntax";
  if (/TypeError/.test(text)) return "type";
}

/** CI receives fixed categories and source positions, never exception messages or payloads. */
export function awsFailureSummary({
  code,
  timedOut,
  stderr,
  phase,
  checks,
  kind: recordedKind,
  location: recordedLocation,
}: {
  code?: unknown;
  timedOut?: unknown;
  stderr?: unknown;
  phase?: unknown;
  checks?: unknown;
  kind?: unknown;
  location?: unknown;
}) {
  const text = typeof stderr === "string" ? stderr : "";
  const source =
    typeof recordedLocation === "string" &&
    /^e2e\/aws\/(runtime|oauth|browser|fixture)\.mjs:\d{1,6}(?::\d{1,6})?$/.test(recordedLocation)
      ? recordedLocation
      : undefined;
  const location =
    /(?:^|[\s(/])(?:[^\s()]*\/)?e2e\/aws\/(runtime|oauth|browser|fixture)\.mjs:(\d{1,6})(?::(\d{1,6}))?/.exec(
      text,
    );
  const detected = failureKind(text);
  const retained =
    typeof recordedKind === "string" && kinds.has(recordedKind) ? recordedKind : "unknown";
  const kind =
    timedOut === true
      ? "timeout"
      : (detected ?? (retained === "unknown" && phase === "browser" ? "browser-launch" : retained));
  return {
    phase:
      typeof phase === "string" && phases.has(phase)
        ? phase
        : kind === "module-resolution"
          ? "module-load"
          : "unknown",
    ...(typeof checks === "number" && Number.isSafeInteger(checks) && checks >= 0
      ? { checks }
      : {}),
    code: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
    timedOut: timedOut === true,
    kind,
    ...(location
      ? {
          location: `e2e/aws/${location[1]}.mjs:${location[2]}${location[3] ? `:${location[3]}` : ""}`,
        }
      : source
        ? { location: source }
        : {}),
  };
}
