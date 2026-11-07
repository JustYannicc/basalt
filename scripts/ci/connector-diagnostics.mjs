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
  "workos-sign-in.mjs",
  "clerk-sign-in.mjs",
  "vercel-sign-in.mjs",
  "elevenlabs-sign-in.mjs",
  "slack-health.mjs",
  "catalog-compat.mjs",
  "elevenlabs-discovery.mjs",
]);
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const packageId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const errorTag = /^(?:[A-Z][A-Za-z0-9]{0,63}|[1-5]\d\d)$/;
const errorStage = /^[a-z][a-z0-9-]{0,47}$/;
const packageLimit = 20;

/**
 * A catalog build report's failed packages, as closed fields only: which package, the error's tag,
 * stage and kind, whether the publisher's own version built, and the catalog's status for a package
 * it could not serve. The failure text stays in the run's private report. Regressions come first,
 * then failures the report did not list as known, so the packages that failed the gate are kept.
 */
function failedPackages(report) {
  const ids = (list) =>
    new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
  const regressions = ids(report.regressions);
  const unlisted = ids(report.unlisted);
  const rank = (result) => (regressions.has(result.id) ? 0 : unlisted.has(result.id) ? 1 : 2);
  const failed = report.results
    .filter((result) => result?.built === false || result?.servedFailure !== undefined)
    .map((result, index) => ({ result, index }))
    .sort((a, b) => rank(a.result) - rank(b.result) || a.index - b.index)
    .map(({ result }) => result);
  if (failed.length === 0) return {};
  return {
    packages: failed.slice(0, packageLimit).map((result) => ({
      id: typeof result.id === "string" && packageId.test(result.id) ? result.id : "invalid",
      ...(typeof result.failureTag === "string" && errorTag.test(result.failureTag)
        ? { tag: result.failureTag }
        : {}),
      ...(typeof result.failureStage === "string" && errorStage.test(result.failureStage)
        ? { stage: result.failureStage }
        : {}),
      ...(typeof result.failure === "string" ? { kind: kindOf(result.failure) } : {}),
      ...(typeof result.originalBuilt === "boolean" ? { originalBuilt: result.originalBuilt } : {}),
      ...(Number.isInteger(result.servedStatus) &&
      result.servedStatus >= 100 &&
      result.servedStatus <= 599
        ? { status: result.servedStatus }
        : {}),
    })),
    ...(failed.length > packageLimit ? { packagesTruncated: true } : {}),
  };
}

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
    ...(stage === "report" && Array.isArray(value.results) && failed ? failedPackages(value) : {}),
  };
}
