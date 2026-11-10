import type { ExecProps } from "alchemy/Command/Exec";
import { Redacted } from "effect";
import {
  cloudflareArtifactsApi,
  ensureEuNamespace,
  failureHeaders,
  stageNamespaces,
} from "../ensure-artifacts.ts";
import { BarrierRefusal } from "./manifest.ts";
import { ArtifactsHttpFailure } from "../artifacts-http-failure.ts";
import { namespaceAdmissionReader, type NamespaceReadOptions } from "./namespace-read.ts";

const commands: Record<
  string,
  { phase: "namespace" | "database" | "verification"; command: string }
> = {
  AppSourceNamespace: { phase: "namespace", command: "node ensure-artifacts.ts" },
  RuntimeDatabaseBudget: { phase: "database", command: "node scripts/database-pool-budget.ts" },
  Migrations: { phase: "database", command: "node src/migrate.ts" },
  PoolDatabase: { phase: "database", command: "node ensure-pool-database.ts" },
  ToolsBackendBudget: { phase: "verification", command: "node verify-database-budget.ts" },
  PoolBackendBudget: { phase: "verification", command: "node verify-database-budget.ts" },
  PoolBackendBudgetRuntimeReady: {
    phase: "verification",
    command: "node verify-database-budget.ts --ready",
  },
  PoolImagePublicationReceipt: { phase: "verification", command: "node capture-pool-image.ts" },
  SentryCloudSourceMaps: {
    phase: "verification",
    command:
      "bunx --no-install sentry-cli sourcemaps upload --url-prefix / .generated/sentry-worker/api",
  },
  SentryAppPagesSourceMaps: {
    phase: "verification",
    command:
      "bunx --no-install sentry-cli sourcemaps upload --url-prefix / .generated/sentry-worker/app-pages",
  },
  SentryMcpServerSourceMaps: {
    phase: "verification",
    command:
      "bunx --no-install sentry-cli sourcemaps upload --url-prefix / .generated/sentry-worker/mcp-server",
  },
};

export const supportedCommand = (id: string) => Object.hasOwn(commands, id);

/** This new read-only check first runs after activation, never during preparation or database work. */
export const firstVerificationCommand = (id: string, props: ExecProps) =>
  id === "PoolBackendBudgetRuntimeReady" &&
  props.memo === false &&
  !props.shell &&
  commands[id]?.phase === "verification" &&
  commands[id]?.command === props.command;
export function commandPhase(id: string, props: ExecProps) {
  const rule = commands[id];
  if (!rule || rule.command !== props.command || props.shell)
    throw new BarrierRefusal("unsupported-command", id);
  return rule.phase;
}

/** A missing namespace is an unsupported new resource, never permission to provision it mid-release. */
export async function admitSourceNamespace(
  props: ExecProps,
  api = cloudflareArtifactsApi,
  options: NamespaceReadOptions = {},
) {
  const value = (key: string) => {
    const configured = props.env?.[key];
    const text = Redacted.isRedacted(configured) ? Redacted.value(configured) : configured;
    if (!text) throw new BarrierRefusal("missing-source-namespace-input");
    return text;
  };
  const provider = api(value("CLOUDFLARE_ACCOUNT_ID"), value("CLOUDFLARE_API_TOKEN"));
  const refuseMutation = async (): Promise<never> => {
    throw new BarrierRefusal("source-namespace-provisioning-required");
  };
  const readOnly = {
    ...provider,
    createNamespace: refuseMutation,
    deleteNamespace: refuseMutation,
    deleteRepository: refuseMutation,
    deleteToken: refuseMutation,
  };
  // The vault namespace is provisioned by an operator before the release that names it.
  for (const namespace of stageNamespaces(value("CLOUD_SOURCE_NAMESPACE"))) {
    try {
      await ensureEuNamespace(
        namespaceAdmissionReader(
          readOnly,
          namespace === value("CLOUD_SOURCE_NAMESPACE") ? "apps" : "vaults",
          options,
        ),
        namespace,
      );
    } catch (error) {
      if (error instanceof BarrierRefusal) throw error;
      throw new BarrierRefusal("source-namespace-not-ready", "AppSourceNamespace", {
        fqn: "AppSourceNamespace",
        type: "Command.Exec",
        changed: [{ path: `namespaces.${namespace}`, old: "readable-eu", new: readFailure(error) }],
        why: [`Reading Artifacts namespace ${namespace} failed: ${readFailure(error)}`],
      });
    }
  }
}

/** The Artifacts client's own operation names, exactly as its failure messages spell them. */
const operations =
  "(?:list|namespace creation|namespace deletion|repository deletion|token list|token deletion)";
const diagnosticsSuffix = String.raw`(?:; diagnostics=(\{.{0,600}\}))?`;
/** Messages the Artifacts client builds itself; nothing else may reach a public report. */
const clientMessages = [
  new RegExp(`^Cloudflare Artifacts ${operations} failed with HTTP (\\d{3})${diagnosticsSuffix}$`),
  new RegExp(`^Cloudflare Artifacts ${operations} was rejected${diagnosticsSuffix}$`),
  new RegExp(`^Cloudflare Artifacts ${operations} returned an invalid response$`),
  /^Cloudflare Artifacts pagination repeated a cursor$/,
  /^Cloudflare Artifacts pagination did not end$/,
  /^Invalid Cloudflare Artifacts list response$/,
  /^Artifacts namespace must have immutable EU jurisdiction; deployment stopped$/,
];
/** Each header keeps the exact shape the client reduces it to; quota parameters are numbers only. */
const diagnosticHeaders: Readonly<Record<string, RegExp>> = {
  ...failureHeaders,
  ratelimit: /^r=\d{1,10};t=\d{1,10}(?:, r=\d{1,10};t=\d{1,10}){0,3}$/,
  "ratelimit-policy": /^q=\d{1,10};w=\d{1,10}(?:, q=\d{1,10};w=\d{1,10}){0,3}$/,
};

/** Rebuild client diagnostics field by field: numeric codes and exactly shaped header values. */
function safeDiagnostics(text: string | undefined) {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const source = parsed as { codes?: unknown; headers?: unknown };
  const codes = Array.isArray(source.codes)
    ? source.codes.filter(
        (code): code is number => Number.isSafeInteger(code) && code > 0 && code <= 99_999_999,
      )
    : [];
  const headers: Record<string, string> = {};
  if (typeof source.headers === "object" && source.headers !== null)
    for (const [name, pattern] of Object.entries(diagnosticHeaders)) {
      const value = (source.headers as Record<string, unknown>)[name];
      if (typeof value === "string" && pattern.test(value)) headers[name] = value;
    }
  return JSON.stringify({ codes, headers });
}

/**
 * Name a failed namespace read by its class and, for the Artifacts client's own failures, its
 * HTTP status and provider codes. Any other error, including a transport error, is reduced to
 * its class, since its text can carry a host or request detail.
 */
export function readFailure(error: unknown) {
  const kind = error instanceof Error ? error.name || "Error" : typeof error;
  if (
    !(error instanceof Error) ||
    (error.constructor !== Error && !(error instanceof ArtifactsHttpFailure))
  )
    return kind;
  for (const pattern of clientMessages) {
    const match = pattern.exec(error.message);
    if (!match) continue;
    const status = /^\d{3}$/.test(match[1] ?? "") ? match[1] : undefined;
    const diagnostics = safeDiagnostics(status ? match[2] : match[1]);
    const summary = error.message.replace(/; diagnostics=.*$/, "");
    return [kind, status && `HTTP ${status}`, summary, diagnostics && `diagnostics=${diagnostics}`]
      .filter(Boolean)
      .join("; ");
  }
  return kind;
}
