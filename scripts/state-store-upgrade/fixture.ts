import {
  bindingDigest,
  digest,
  makePlan,
  workerId,
  type Candidate,
  type Observation,
} from "./plan.ts";
import { cloudflare } from "./cloudflare.ts";

export const candidate: Candidate = {
  main: "Api.js",
  compatibility: { date: "2026-08-31", flags: ["new_module_registry"] },
  files: [
    {
      name: "Api.js",
      type: "application/javascript+module",
      bytes: new TextEncoder().encode("export default {}"),
    },
  ],
};
export function fixture() {
  const accountId = "a".repeat(32);
  const initial: Observation = {
    accountId,
    workerId,
    protocol: 7,
    deploymentId: "old-deployment",
    versionId: "old-version",
    latestVersionId: "old-version",
    bindings: [
      { name: "ALCHEMY_PHASE", type: "plain_text", text: "runtime" },
      { name: "PRIVATE_VALUE", type: "plain_text", text: "never-print-this-binding-value" },
      {
        name: "Store",
        type: "durable_object_namespace",
        class_name: "Store",
        namespace_id: "b".repeat(32),
      },
      {
        name: "AlchemyStateStoreToken",
        type: "secrets_store_secret",
        store_id: "c".repeat(32),
        secret_name: "AlchemyStateStoreToken",
      },
      {
        name: "StateStoreEncryptionKey",
        type: "secrets_store_secret",
        store_id: "c".repeat(32),
        secret_name: "AlchemyStateStoreEncryptionKey",
      },
    ],
    settings: {},
    runtimeSettings: {
      compatibility_date: "2026-08-31",
      compatibility_flags: ["new_module_registry"],
    },
    namespace: { id: "b".repeat(32), class: "Store", script: workerId, use_sqlite: true },
    encryptionKey: {},
  };
  const secret = {
    id: "encryption-secret-id",
    name: "AlchemyStateStoreEncryptionKey",
    created_on: "2026-10-15T00:00:00Z",
    modified_on: "2026-10-15T00:00:00Z",
  };
  initial.settings = {
    bindings: initial.bindings,
    compatibility_date: candidate.compatibility.date,
    compatibility_flags: candidate.compatibility.flags,
    placement: { mode: "off" },
    logpush: false,
    observability: { enabled: true },
    annotations: {},
    tags: ["alchemy:stack:CloudflareStateStore"],
  };
  initial.encryptionKey = {
    binding: initial.bindings[4],
    id: secret.id,
    created_on: secret.created_on,
    modified_on: secret.modified_on,
    metadataSha256: digest(secret),
  };
  const state = structuredClone(initial);
  const requests: { method: string; url: string; body?: unknown; authorized: boolean }[] = [];
  let getCount = 0;
  const hooks: {
    read?: (count: number) => void;
    uploaded?: () => void;
    activated?: () => void;
    uploadError?: boolean;
    activateError?: boolean;
    startup?: unknown;
  } = {};
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const call: (typeof requests)[number] = {
      method,
      url: url.href,
      authorized: new Headers(init.headers).has("Authorization"),
    };
    requests.push(call);
    if (method === "GET") hooks.read?.(++getCount);
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (url.hostname.endsWith(".workers.dev")) return Response.json({ version: state.protocol });
    const path = url.pathname.replace(`/client/v4/accounts/${accountId}`, "");
    const script = `/workers/scripts/${workerId}`;
    if (method === "GET") {
      if (path === script + "/settings") return ok(state.settings);
      if (path === script + "/deployments")
        return ok({
          deployments: [
            {
              id: state.deploymentId,
              created_on: "2026-11-08T00:00:00Z",
              versions: [{ version_id: state.versionId, percentage: 100 }],
            },
          ],
        });
      if (path === script + "/versions")
        return ok({
          items: [
            { id: state.latestVersionId, number: state.latestVersionId === "old-version" ? 1 : 2 },
          ],
        });
      if (path.startsWith(script + "/versions/")) {
        const id = path.split("/").at(-1);
        const bindings = id === "old-version" ? initial.bindings : state.bindings;
        const runtime = id === "old-version" ? initial.runtimeSettings : state.runtimeSettings;
        return ok({ id, resources: { bindings, script_runtime: runtime } });
      }
      if (path === "/workers/durable_objects/namespaces") return ok([state.namespace]);
      if (path === `/secrets_store/stores/${"c".repeat(32)}/secrets`)
        return ok([{ ...secret, modified_on: state.encryptionKey.modified_on }]);
      if (path === "/workers/subdomain") return ok({ subdomain: "synthetic" });
    }
    if (method === "POST" && path === script + "/versions") {
      if (!(init.body instanceof FormData)) throw new Error("Expected multipart");
      const metadata = init.body.get("metadata");
      if (!(metadata instanceof Blob)) throw new Error("Expected metadata");
      call.body = JSON.parse(await metadata.text());
      if (url.searchParams.get("bindings_inherit") !== "strict")
        throw new Error("Missing strict inheritance");
      if (hooks.uploadError) throw new Error("transport error with never-log-provider-token");
      state.latestVersionId = "new-version";
      hooks.uploaded?.();
      return ok({ id: "new-version", startup_time_ms: "startup" in hooks ? hooks.startup : 5 });
    }
    if (method === "POST" && path === script + "/deployments") {
      call.body = JSON.parse(String(init.body));
      if (hooks.activateError) throw new Error("transport error with never-log-provider-token");
      state.versionId = "new-version";
      state.deploymentId = "new-deployment";
      state.protocol = 8;
      hooks.activated?.();
      return ok({ id: state.deploymentId });
    }
    throw new Error(`Unexpected ${method} request`);
  };
  const plan = makePlan(initial, candidate);
  const expected = {
    workerId,
    deploymentId: initial.deploymentId,
    namespaceId: initial.namespace.id,
    version: "7",
    planSha256: digest(plan),
  };
  return {
    initial,
    state,
    hooks,
    requests,
    fetcher,
    api: cloudflare(accountId, "never-log-provider-token", fetcher),
    expected,
    plan,
    bindingDigest: () => bindingDigest(state.bindings),
  };
}
