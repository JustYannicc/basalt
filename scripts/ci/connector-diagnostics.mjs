import { parseClosedErrorClass } from "../connectors-tests/guidance-failure.ts";

const phases = new Set([
  "unknown",
  "process-startup",
  "runtime-startup",
  "callback-receiver",
  "provider-emulator",
  "browser-launch",
  "published-emulator-ready",
  "self-host-environment",
  "locked-registry",
  "zendesk-fixtures",
  "gitlab-fixtures",
  "catalog-worker",
  "catalog-source",
  "scenario-preparation",
  "test-accounts",
  "product-server",
  "zendesk-runtime",
  "gitlab-runtime",
  "site-ui",
  "gitlab-site-ui",
  "real-runtime-and-shared-app-ready",
  "two-native-oauth-accounts-completed",
  "same-organization-native-mcp-isolation-passed",
  "installed-claude-proof-skipped-in-ci",
  "installed-claude-real-mcp-passed",
  "initialization",
  "global-client-preference",
  "tenant-public-client",
  "company-guidance",
]);
const kinds = new Set([
  "assertion",
  "browser-launch",
  "module-load",
  "dns",
  "connection",
  "permission",
  "timeout",
  "runtime",
  "process",
  "syntax",
  "type",
  "unknown",
]);
const sources = new Set([
  "runtime.mjs",
  "gitlab.mjs",
  "zendesk.mjs",
  "account-site-ui.mjs",
  "zendesk-tenant-runtime.mjs",
  "zendesk-tenant-public.mjs",
  "zendesk-company-guidance.mjs",
  "zendesk-operator-choices.mjs",
  "vercel-sign-in.mjs",
  "elevenlabs-sign-in.mjs",
  "slack-health.mjs",
  "catalog-compat.mjs",
  "elevenlabs-discovery.mjs",
]);
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

function kindOf(text) {
  if (/AssertionError|ERR_ASSERTION/.test(text)) return "assertion";
  if (/browserType\.launch|Executable doesn't exist/.test(text)) return "browser-launch";
  if (/Cannot find (?:module|package)|ModuleNotFound|ERR_MODULE_NOT_FOUND/.test(text))
    return "module-load";
  if (/SyntaxError/.test(text)) return "syntax";
  if (/TypeError/.test(text)) return "type";
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "dns";
  if (/ECONNREFUSED|ECONNRESET/.test(text)) return "connection";
  if (/EACCES|EPERM/.test(text)) return "permission";
  if (/[Tt]imeout|[Tt]imed out/.test(text)) return "timeout";
  return "unknown";
}

/** Project fixed diagnostic categories; never redact and republish arbitrary proof output. */
export function connectorDiagnostic(stage, input, failureFile = false) {
  const value = input !== null && typeof input === "object" ? input : {};
  const text =
    typeof input === "string" ? input : typeof value.stderr === "string" ? value.stderr : "";
  let phase = "unknown",
    kind = kindOf(text),
    checks;
  const marker =
    /CONNECTORS_PROOF_FAILURE phase=([a-z-]+) kind=([a-z-]+) at=([a-z0-9-]+\.mjs):(\d{1,6})/.exec(
      text,
    );
  const phaseMarker = /CONNECTORS_PROOF_FAILURE phase=([a-z-]+) kind=([a-z-]+)/.exec(text);
  if (phaseMarker) {
    if (phases.has(phaseMarker[1])) phase = phaseMarker[1];
    if (kinds.has(phaseMarker[2])) kind = phaseMarker[2];
  }
  for (const line of (typeof value.stdout === "string" ? value.stdout : "").split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (phases.has(record?.stage)) phase = record.stage;
      if (count(record?.checks)) checks = record.checks;
    } catch {
      const tenantPhase = /^Zendesk tenant proof: ([a-z-]+)$/.exec(line);
      if (tenantPhase && phases.has(tenantPhase[1])) phase = tenantPhase[1];
    }
  }
  const frame = marker ?? /(?:^|[\s(/])([a-z0-9-]+\.mjs):(\d{1,6})(?::\d{1,6})?/.exec(text);
  const source = marker ? marker[3] : frame?.[1];
  const line = marker ? Number(marker[4]) : Number(frame?.[2]);
  const results = Array.isArray(input)
    ? input
    : Array.isArray(value.results)
      ? value.results
      : Array.isArray(value.checks)
        ? value.checks
        : undefined;
  if (count(value.checks)) checks = value.checks;
  else if (results) checks = Math.min(results.length, 1_000_000);
  const failed =
    failureFile ||
    (Number.isInteger(value.code) && value.code !== 0) ||
    (count(value.failed) && value.failed > 0) ||
    results?.some((result) => result?.passed === false);
  const errorClass = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("CONNECTORS_PROOF_FAILURE "))
    .map(parseClosedErrorClass)
    .find((value) => value !== undefined);
  return {
    stage,
    outcome: failed ? "failed" : value.code === 0 ? "passed" : "observed",
    phase,
    kind,
    ...errorClass,
    ...(Number.isInteger(value.code) && value.code >= 0 && value.code <= 255
      ? { code: value.code }
      : {}),
    ...(checks === undefined ? {} : { checks }),
    ...(sources.has(source) && line > 0 ? { location: `${source}:${line}` } : {}),
  };
}
