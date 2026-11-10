import type { ExecProps } from "alchemy/Command/Exec";
import { Redacted } from "effect";
import { cloudflareArtifactsApi, ensureEuNamespace, stageNamespaces } from "../ensure-artifacts.ts";
import { BarrierRefusal } from "./manifest.ts";

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
export async function admitSourceNamespace(props: ExecProps, api = cloudflareArtifactsApi) {
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
      await ensureEuNamespace(readOnly, namespace);
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

/**
 * Name a failed namespace read by its class, HTTP status and provider codes. The Artifacts client
 * builds its own messages from allow-listed fields; anything else is reduced to its class, since a
 * transport error can carry a host or request detail.
 */
export function readFailure(error: unknown) {
  const kind = error instanceof Error ? error.name || "Error" : typeof error;
  const message = error instanceof Error ? error.message : "";
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  const diagnostics = /; diagnostics=(\{.{0,600}\})$/.exec(message)?.[1];
  const known =
    /^(?:Cloudflare Artifacts [a-z ]+(?:failed with HTTP \d{3}|was rejected|returned an invalid response|pagination repeated a cursor|pagination did not end)|Invalid Cloudflare Artifacts list response|Artifacts namespace must have immutable EU jurisdiction; deployment stopped)/.exec(
      message,
    )?.[0];
  return [kind, status && `HTTP ${status}`, known, diagnostics && `diagnostics=${diagnostics}`]
    .filter(Boolean)
    .join("; ");
}
