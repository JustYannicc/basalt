/**
 * The one production-shaped source for PoolWorker stand-ins, from the release owner's read-only
 * reads of production: the version read-back's exact top-level keys (no `exports`, `migrations` or
 * `migration_tag`), settings tags that are exactly alchemy's stack, stage, id and dos tags (no
 * migration tag), and a script runtime without `migration_tag`. Every stand-in builds its responses
 * here; ../production-pool-worker-shape.test.ts fails if one drifts.
 */
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { transform } from "esbuild";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/http/HttpClient";

export const productionVersionKeys = [
  "id",
  "number",
  "startup_time_ms",
  "compatibility_date",
  "compatibility_flags",
  "main_module",
  "annotations",
  "usage_model",
  "containers",
  "urls",
  "source",
  "created_on",
  "modules",
  "bindings",
  "env",
  "author_id",
  "author_email",
] as const;
export const productionTagPrefixes = [
  "alchemy:stack:",
  "alchemy:stage:",
  "alchemy:id:",
  "alchemy:dos:",
] as const;

const compatibilityDate = "2026-09-08";
const compatibilityFlags = ["nodejs_compat"];

export const cloudflareResult = (result: unknown, info?: unknown) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(info ? { result_info: info } : {}),
  });
export const cloudflareFailure = (message: string, status = 400, code = 10074) =>
  Response.json({ success: false, errors: [{ code, message }] }, { status });

/** Alchemy's reserved tags for PoolWorker: identity, the packed DO map, and a tag only if one exists. */
export const productionTags = (classes: readonly string[], migrationTag?: string) => [
  "alchemy:stack:basalt",
  "alchemy:stage:production",
  "alchemy:id:PoolWorker",
  `alchemy:dos:${[...classes].sort().join(";")}`,
  ...(migrationTag ? [`alchemy:migration-tag:${migrationTag}`] : []),
];

export function productionVersionBody(input: {
  id: string;
  mainModule: string;
  modules: readonly { name: string; content_type: string; content_base64: string }[];
  bindings: readonly unknown[];
  containers: readonly string[];
  annotations?: Readonly<Record<string, string>>;
}) {
  const version = {
    id: input.id,
    number: 7,
    startup_time_ms: 12,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
    main_module: input.mainModule,
    annotations: input.annotations ?? { "workers/triggered_by": "upload" },
    usage_model: "standard",
    containers: input.containers.map((class_name) => ({ class_name })),
    urls: [],
    source: "api",
    created_on: "2026-11-17T00:00:00Z",
    modules: input.modules,
    bindings: input.bindings,
    env: {},
    author_id: "synthetic-author",
    author_email: "synthetic@example.invalid",
  };
  if (Object.keys(version).join() !== productionVersionKeys.join())
    throw new Error("production version stand-in drifted from the observed key set");
  return version;
}

/** The exact top-level keys of production's PoolWorker settings read (read-only capture, 2026-11-18). */
export const productionSettingsKeys = [
  "placement",
  "compatibility_date",
  "compatibility_flags",
  "usage_model",
  "tags",
  "tail_consumers",
  "logpush",
  "observability",
  "annotations",
  "bindings",
] as const;
/** Cloudflare stamps this on every version and returns it from reads; uploads that carry it are refused. */
export const providerTriggeredBy = "workers/triggered_by";
/** Values follow PoolWorker's declaration (no placement, telemetry's workerObservability); keys are production's. */
export const productionObservability = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
  redact_query_string: true,
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
};

export function productionSettingsBody(
  bindings: readonly unknown[],
  tags: readonly string[],
  annotations: Readonly<Record<string, string>> = {},
) {
  const settings = {
    placement: {},
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
    usage_model: "standard",
    tags,
    tail_consumers: [],
    logpush: false,
    observability: productionObservability,
    // Production's settings read returned "version_upload"; a stamp is never matched by value.
    annotations: { [providerTriggeredBy]: "version_upload", ...annotations },
    bindings,
  };
  if (Object.keys(settings).join() !== productionSettingsKeys.join())
    throw new Error("production settings stand-in drifted from the observed key set");
  return settings;
}

/** Cloudflare compiles every uploaded module and refuses the upload when one does not parse. */
export async function productionModuleRefusal(
  modules: readonly { name: string; type: string; bytes: Uint8Array }[],
) {
  for (const module of modules) {
    if (module.type !== "application/javascript+module") continue;
    try {
      await transform(new TextDecoder().decode(module.bytes), {
        format: "esm",
        loader: "js",
        logLevel: "silent",
      });
    } catch (error) {
      const [first] = (error as { errors?: { text: string }[] }).errors ?? [];
      return cloudflareFailure(
        `Uncaught SyntaxError in ${module.name}: ${first?.text ?? "unparseable"}`,
        400,
        10021,
      );
    }
  }
  return undefined;
}

export const productionScriptVersionBody = (input: {
  id: string;
  bindings: readonly unknown[];
  classes: readonly string[];
  migrationTag?: string;
}) => ({
  id: input.id,
  number: 7,
  resources: {
    bindings: input.bindings,
    script_runtime: input.migrationTag ? { migration_tag: input.migrationTag } : {},
    script: { named_handlers: input.classes.map((name) => ({ name, handlers: [] })) },
  },
});

export const productionProfileBody = (scriptName: string, id: string) => ({
  id,
  name: scriptName,
  created_on: "2026-11-01T00:00:00Z",
  updated_on: "2026-11-17T00:00:00Z",
  logpush: false,
  observability: {},
  references: [],
  subdomain: { enabled: false, previews_enabled: false },
  tags: [],
  tail_consumers: [],
});

export const productionDeploymentsBody = (versionId: string) => ({
  deployments: [
    {
      id: `deployment-${versionId}`,
      created_on: "2026-11-17T00:00:00Z",
      source: "api",
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
    },
  ],
});

/** One page of the account's DO namespaces; later pages are empty. */
export const productionNamespaceResponse = (url: URL, rows: readonly unknown[]) => {
  const page = Number(url.searchParams.get("page") ?? "1");
  const served = page > 1 ? [] : rows;
  return cloudflareResult(served, {
    page,
    per_page: 1000,
    count: served.length,
    total_count: rows.length,
    total_pages: 1,
  });
};

export const productionNamespaceRow = (scriptName: string, className: string, id: string) => ({
  id,
  name: `${scriptName}_${className}`,
  script: scriptName,
  class: className,
  use_sqlite: true,
});

/** The SDK services a reader needs: this client, a synthetic token and configuration. */
export const productionSdkLayer = (
  client: HttpClient.HttpClient,
  env: Record<string, string> = {},
) =>
  Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("synthetic-only"),
        apiBaseUrl: "https://api.cloudflare.com/client/v4",
      }),
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );
