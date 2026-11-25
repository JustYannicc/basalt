// Production read-backs recorded on 2026-11-18 (key names, JSON types and enum values kept; ids and
// names replaced). Only the identifiers a test needs are filled in by the builders below.

export const scriptListItem = {
  created_on: "2026-11-18T18:48:47Z",
  modified_on: "2026-11-18T18:48:47Z",
  id: "<name>",
  tag: "<id>",
  tags: ["alchemy:stack:<name>", "alchemy:stage:<name>", "alchemy:id:<name>", "alchemy:dos:<name>"],
  deployment_id: "<id>",
  tail_consumers: null,
  logpush: false,
  observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true },
  has_assets: false,
  has_modules: true,
  etag: "<id>",
  handlers: ["fetch", "scheduled"],
  named_handlers: [{ name: "PoolOperations", handlers: ["fetch"] }],
  last_deployed_from: "api",
  compatibility_date: "2026-09-08",
  compatibility_flags: ["nodejs_compat", "new_module_registry"],
  usage_model: "standard",
  containers: [{ class_name: "<name>" }],
  routes: null,
};

export const workerSettings = {
  placement: {},
  compatibility_date: "2026-09-08",
  compatibility_flags: ["nodejs_compat", "new_module_registry"],
  usage_model: "standard",
  tags: ["alchemy:stack:<name>", "alchemy:stage:<name>", "alchemy:id:<name>", "alchemy:dos:<name>"],
  tail_consumers: [],
  logpush: false,
  observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true },
  annotations: { "workers/triggered_by": "version_upload" },
  bindings: [
    {
      class_name: "<name>",
      name: "<name>",
      namespace_id: "<id>",
      script_name: "<name>",
      type: "durable_object_namespace",
    },
    { name: "<name>", type: "secret_text" },
    { id: "<id>", name: "<name>", type: "hyperdrive" },
    {
      class_name: "<name>",
      name: "<name>",
      namespace_id: "<id>",
      type: "durable_object_namespace",
    },
    { name: "<name>", secret_name: "<name>", store_id: "<id>", type: "secrets_store_secret" },
    { environment: "<name>", name: "<name>", service: "<name>", type: "service" },
  ] as Record<string, string>[],
};

/** The RESOLVED application read-back: no instance_type, runtime "firecracker", health and network. */
export const resolvedApplication = {
  id: "<id>",
  created_at: "2026-11-18T18:30:00Z",
  updated_at: "2026-11-18T18:31:00Z",
  account_id: "<id>",
  name: "<name>",
  version: 1,
  scheduling_policy: "default",
  instances: 0,
  max_instances: 4,
  configuration: {
    image: "<registry>/<name>@sha256:<hex>",
    vcpu: 0.25,
    memory: "1GiB",
    memory_mib: 1024,
    disk: { size_mb: 4000, size: "4GB" },
    environment_variables: [{ name: "<name>", value: "<text>" }],
    network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
    command: [],
    entrypoint: [],
    runtime: "firecracker",
    observability: { logs: { enabled: true } },
  },
  constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" },
  durable_objects: { namespace_id: "<id>" },
  health: {
    errors: [],
    instances: {
      active: 0,
      assigned: 0,
      healthy: 0,
      stopped: 0,
      failed: 0,
      scheduling: 0,
      starting: 0,
    },
  },
  network: { bandwidth_limit_mbps: 250 },
};

export const envelope = (result: unknown) => ({ success: true, result, messages: [], errors: [] });

// Workers custom domains, recorded on 2026-11-25 (structure only: key names, JSON types and the
// envelope's null-versus-[] kept; every value is made up in the recorded form).

/** An item of GET /accounts/{id}/workers/domains, and the result of a read of one domain. */
export const workerDomain = {
  id: "0123456789abcdef0123456789abcdef01234567",
  zone_id: "0123456789abcdef0123456789abcdef",
  zone_name: "<zone>",
  hostname: "<hostname>",
  service: "<name>",
  environment: "<environment>",
  cert_id: "<id>",
  previews_enabled: false,
  enabled: true,
};

/** GET /accounts/{id}/workers/domains: the list answers null for errors and messages. */
export const workerDomainList = (result: readonly unknown[]) => ({
  result,
  success: true,
  errors: null,
  messages: null,
  result_info: { page: 1, per_page: 50, count: result.length, total_count: result.length },
});

/** GET /accounts/{id}/workers/domains/{domainId}: no result_info, and [] where the list has null. */
export const workerDomainRead = (result: unknown) => ({
  result,
  success: true,
  errors: [],
  messages: [],
});

/** The same read of an id Cloudflare does not know: HTTP 404 with this body. */
export const workerDomainNotFound = (id: string) => ({
  result: null,
  success: false,
  errors: [{ code: 100114, message: `Origin '${id}' not found.` }],
  messages: [],
});
