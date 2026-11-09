import { envelopeFailure, responseFailure } from "./provider-failure.ts";
import { UpgradeRefusal, workerId, digest, type Binding, type Observation } from "./plan.ts";
import { normalizePlacement } from "../release-barrier/script-placement.ts";

export const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new UpgradeRefusal(workerId, "provider-response", "object", "invalid");
  return value as Record<string, unknown>;
};
export const string = (value: unknown, property: string): string => {
  if (typeof value !== "string" || !value)
    throw new UpgradeRefusal(workerId, property, "nonempty string", "invalid");
  return value;
};
const array = (value: unknown) => {
  if (!Array.isArray(value))
    throw new UpgradeRefusal(workerId, "provider-response", "array", "invalid");
  return value.map(object);
};

export function cloudflare(accountId: string, token: string, fetcher: typeof fetch = fetch) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !token)
    throw new UpgradeRefusal(
      workerId,
      "credentials",
      "configured release account",
      "missing-or-invalid",
    );
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!path.startsWith("/") || path.includes(".."))
      throw new UpgradeRefusal(workerId, "api-path", "account-scoped path", "invalid");
    const response = await fetcher(base + path, {
      ...init,
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new UpgradeRefusal(
        workerId,
        "provider-http-status",
        "2xx",
        response.status,
        undefined,
        await responseFailure(response, token),
      );
    }
    const envelope = object(await response.json());
    if (envelope.success !== true)
      throw new UpgradeRefusal(
        workerId,
        "provider-success",
        "true",
        "false-or-missing",
        undefined,
        envelopeFailure(envelope, token),
      );
    return envelope.result;
  }
  async function list(path: string) {
    const result: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const items = array(await request(`${path}?page=${page}&per_page=100`));
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new UpgradeRefusal(workerId, "provider-pagination", "within 100 pages", "limit-reached");
  }
  const script = `/workers/scripts/${workerId}`;
  const stateStore = { fetch: fetcher };
  async function protocol() {
    const subdomain = string(
      object(await request("/workers/subdomain")).subdomain,
      "workers-subdomain",
    );
    if (!/^[a-z0-9-]+$/.test(subdomain))
      throw new UpgradeRefusal(workerId, "workers-subdomain", "one DNS label", "invalid");
    const response = await stateStore.fetch(
      `https://${workerId}.${subdomain}.workers.dev/version`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpgradeRefusal(workerId, "version-http-status", "200", response.status);
    }
    const version = object(await response.json()).version;
    if (!Number.isInteger(version))
      throw new UpgradeRefusal(workerId, "state-store-version", "integer", "invalid");
    return Number(version);
  }
  async function deployment() {
    const deployments = array(object(await request(script + "/deployments")).deployments);
    if (
      !deployments.length ||
      deployments.some((item) => !Number.isFinite(Date.parse(String(item.created_on))))
    )
      throw new UpgradeRefusal(
        workerId,
        "deployments",
        "dated serving deployment",
        "missing-or-invalid",
      );
    const current = deployments.sort(
      (a, b) => Date.parse(String(b.created_on)) - Date.parse(String(a.created_on)),
    )[0]!;
    const versions = array(current.versions);
    if (versions.length !== 1 || versions[0]?.percentage !== 100)
      throw new UpgradeRefusal(
        workerId,
        "serving-versions",
        "one version at 100 percent",
        "split-or-invalid",
      );
    return {
      id: string(current.id, "deployment-id"),
      versionId: string(versions[0]?.version_id, "version-id"),
    };
  }
  function bindings(value: unknown): Binding[] {
    return array(value).map((item) => ({
      ...item,
      name: string(item.name, "binding-name"),
      type: string(item.type, "binding-type"),
    }));
  }
  async function version(id: string) {
    const version = object(await request(script + "/versions/" + encodeURIComponent(id)));
    if (version.id !== id)
      throw new UpgradeRefusal(workerId, "immutable-version-id", id, "mismatched");
    const resources = object(version.resources);
    const runtime = object(resources.script_runtime);
    if (
      !Array.isArray(runtime.compatibility_flags) ||
      runtime.compatibility_flags.some((flag) => typeof flag !== "string")
    )
      throw new UpgradeRefusal(
        workerId,
        "immutable-compatibility-flags",
        "string array",
        "invalid",
      );
    const runtimeSettings: Record<string, unknown> = {
      compatibility_date: string(runtime.compatibility_date, "immutable-compatibility-date"),
      compatibility_flags: runtime.compatibility_flags,
    };
    if (runtime.limits != null) runtimeSettings.limits = runtime.limits;
    if (runtime.usage_model != null) runtimeSettings.usage_model = runtime.usage_model;
    if (resources.script != null && object(resources.script).placement != null)
      runtimeSettings.placement = normalizePlacement(object(resources.script).placement);
    return { bindings: bindings(resources.bindings), runtimeSettings };
  }
  async function observe(): Promise<Observation> {
    const first = await deployment();
    const settings = object(await request(script + "/settings"));
    const observedBindings = bindings(settings.bindings);
    const versions = array(object(await request(script + "/versions?per_page=100")).items);
    if (
      versions.some(
        (version) => !Number.isSafeInteger(version.number) || Number(version.number) < 0,
      )
    )
      throw new UpgradeRefusal(workerId, "version-order", "numbered versions", "invalid");
    const latest = versions.sort((a, b) => Number(b.number) - Number(a.number))[0];
    if (!latest) throw new UpgradeRefusal(workerId, "latest-version", "present", "missing");
    const serving = await version(first.versionId);
    const store = observedBindings.find((binding) => binding.name === "Store");
    const namespaceId = string(store?.namespace_id, "Store-namespace-id");
    const namespaces = await list("/workers/durable_objects/namespaces");
    const namespace = namespaces.find((item) => item.id === namespaceId);
    if (!namespace) throw new UpgradeRefusal("Store", "namespace-id", namespaceId, "missing");
    const key = observedBindings.find((binding) => binding.name === "StateStoreEncryptionKey");
    const storeId = string(key?.store_id, "encryption-secret-store-id");
    const secretName = string(key?.secret_name, "encryption-secret-name");
    const secrets = await list(`/secrets_store/stores/${encodeURIComponent(storeId)}/secrets`);
    const matches = secrets.filter((secret) => secret.name === secretName);
    if (matches.length !== 1)
      throw new UpgradeRefusal("StateStoreEncryptionKey", "matching-secrets", 1, matches.length);
    const secret = matches[0]!;
    const encryptionKey = {
      binding: key,
      id: string(secret.id, "encryption-secret-id"),
      created_on: secret.created_on,
      modified_on: secret.modified_on,
      metadataSha256: digest(secret),
    };
    const observedProtocol = await protocol();
    const last = await deployment();
    if (last.id !== first.id || last.versionId !== first.versionId)
      throw new UpgradeRefusal(workerId, "deployment-during-read", first.id, last.id);
    return {
      accountId,
      workerId,
      protocol: observedProtocol,
      deploymentId: first.id,
      versionId: first.versionId,
      latestVersionId: string(latest.id, "latest-version-id"),
      settings,
      runtimeSettings: serving.runtimeSettings,
      bindings: observedBindings,
      servingBindings: serving.bindings,
      namespace: {
        id: namespaceId,
        class: string(namespace.class, "namespace-class"),
        script: string(namespace.script, "namespace-script"),
        use_sqlite: namespace.use_sqlite === true,
      },
      encryptionKey,
    };
  }
  return {
    observe,
    protocol,
    deployment,
    version,
    upload: (body: FormData) =>
      request(script + "/versions?bindings_inherit=strict", { method: "POST", body }),
    activate: (versionId: string) =>
      request(script + "/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ version_id: versionId, percentage: 100 }],
        }),
      }),
  };
}
export type Cloudflare = ReturnType<typeof cloudflare>;
