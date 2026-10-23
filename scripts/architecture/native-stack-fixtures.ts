/** Only declaration identities and binding names/types may cross the process boundary. */
export interface NativeResource {
  type: string;
  fqn: string;
  declaredName: string;
}

export interface WorkerMetadata {
  fqn: string;
  bindings: { name: string; kind: string }[];
  deferredBindingCount: number;
}

export interface NativeInventory {
  version: 1;
  resources: NativeResource[];
  workers: WorkerMetadata[];
}

type RecordValue = Record<string, unknown>;
function record(value: unknown, location = "record"): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid native declaration metadata:${location}-${Array.isArray(value) ? "array" : typeof value}`);
  return value as RecordValue;
}

export function safeName(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || value.includes("://") || /\s/.test(value) || !/^[A-Za-z0-9_$][A-Za-z0-9_$.:/\-]*$/.test(value))
    throw new Error("Invalid native declaration name");
  return value;
}

/** Never resolve an Output or inspect a binding value to infer its type. */
export function inventoryDeclarations(resources: readonly unknown[], bindings: RecordValue, isDeferred: (value: unknown) => boolean = () => false): NativeInventory {
  const result: NativeInventory = { version: 1, resources: [], workers: [] };
  const workflows = new Set(resources.map(value => record(value, "resource")).filter(r => r.Type === "Cloudflare.Workflow").map(r => safeName(r.LogicalId)));
  for (const value of resources) {
    const resource = record(value, "resource");
    const type = safeName(resource.Type);
    const fqn = safeName(resource.FQN);
    result.resources.push({ type, fqn, declaredName: safeName(resource.LogicalId) });
    if (type !== "Cloudflare.Worker") continue;
    const props = resource.Props == null ? {} : record(resource.Props, "props");
    const names = new Map<string, Set<string>>();
    const localClasses = new Set<string>();
    let deferredBindingCount = 0;
    const add = (name: unknown, kind: string) => {
      const key = safeName(name);
      const kinds = names.get(key) ?? new Set<string>();
      kinds.add(kind);
      names.set(key, kinds);
    };
    const collect = (data: RecordValue) => {
      for (const [name, entry] of Object.entries(data.env == null ? {} : record(data.env, "env")))
        if (entry !== undefined) add(name, "env");
      if (data.bindings !== undefined) {
        if (!Array.isArray(data.bindings)) throw new Error("Invalid native bindings");
        for (const value of data.bindings) {
          if (isDeferred(value)) { deferredBindingCount++; continue; }
          const binding = record(value, "binding");
          const kind = safeName(binding.type);
          if (kind !== "durable_object_namespace") {
            add(binding.name, kind);
            continue;
          }
          // WorkerProvider merges export and binding declarations by className.
          // An unresolved scriptName cannot establish that the class is local.
          if (isDeferred(binding.scriptName) || isDeferred(binding.className)) {
            add(binding.name, `${kind}:unresolved`);
            deferredBindingCount++;
            continue;
          }
          const local = binding.scriptName === undefined;
          add(binding.name, `${kind}:${local ? "local" : "remote"}`);
          if (local && binding.className !== undefined) localClasses.add(safeName(binding.className));
        }
      }
    };
    collect(props);
    const registered = bindings[fqn] ?? [];
    if (!Array.isArray(registered)) throw new Error("Invalid native binding contributions");
    for (const contribution of registered) {
      const data = record(contribution, "contribution").data;
      if (data != null) collect(record(data, "data"));
    }
    for (const [name, value] of Object.entries(props.exports == null ? {} : record(props.exports, "exports"))) {
      // WorkerRuntimeContext also returns the default event/RPC handler, outside WorkerExport.
      if (name === "default") continue;
      const exported = record(value, "export");
      if (exported.kind === "durableObject") {
        localClasses.add(safeName(name));
      } else if (exported.kind === "workflow") {
        if (!workflows.has(name)) throw new Error("Unmatched native workflow export");
      } else if (exported.kind !== "sqlMigrations") {
        throw new Error("Unknown native Worker export kind");
      }
    }
    for (const name of localClasses)
      result.resources.push({ type: "Cloudflare.DurableObject", fqn: `${fqn}/exports/${name}`, declaredName: name });
    result.workers.push({ fqn, deferredBindingCount, bindings: [...names].flatMap(([name, kinds]) =>
      [...kinds].map(kind => ({ name, kind }))).sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)) });
  }
  return validateInventory(result);
}

/** Reject unexpected fields, including accidental props, URLs, or error messages. */
export function validateInventory(value: unknown): NativeInventory {
  const exact = (value: unknown, keys: readonly string[]) => {
    const item = record(value);
    if (Object.keys(item).sort().join(",") !== [...keys].sort().join(",")) throw new Error("Invalid native inventory fields");
    return item;
  };
  const envelope = exact(value, ["version", "resources", "workers"]);
  if (envelope.version !== 1 || !Array.isArray(envelope.resources) || !Array.isArray(envelope.workers))
    throw new Error("Invalid native inventory format");
  const ids = new Set<string>();
  const resources = envelope.resources.map(value => {
    const item = exact(value, ["type", "fqn", "declaredName"]);
    const type = safeName(item.type), fqn = safeName(item.fqn), declaredName = safeName(item.declaredName);
    const key = `${type}\0${fqn}`;
    if (ids.has(key)) throw new Error("Duplicate native resource identity");
    ids.add(key);
    return { type, fqn, declaredName };
  }).sort((a, b) => a.fqn.localeCompare(b.fqn) || a.type.localeCompare(b.type));
  const seenWorkers = new Set<string>();
  const workers = envelope.workers.map(value => {
    const item = exact(value, ["fqn", "bindings", "deferredBindingCount"]);
    const fqn = safeName(item.fqn);
    if (!ids.has(`Cloudflare.Worker\0${fqn}`) || seenWorkers.has(fqn) || !Array.isArray(item.bindings))
      throw new Error("Invalid native Worker identity");
    seenWorkers.add(fqn);
    const deferredBindingCount = item.deferredBindingCount;
    if (typeof deferredBindingCount !== "number" || !Number.isSafeInteger(deferredBindingCount) || deferredBindingCount < 0)
      throw new Error("Invalid native deferred binding count");
    const bindings = item.bindings.map(value => {
      const binding = exact(value, ["name", "kind"]);
      return { name: safeName(binding.name), kind: safeName(binding.kind) };
    });
    return { fqn, bindings, deferredBindingCount };
  }).sort((a, b) => a.fqn.localeCompare(b.fqn));
  if (resources.filter(r => r.type === "Cloudflare.Worker").length !== workers.length)
    throw new Error("Missing native Worker metadata");
  return { version: 1, resources, workers };
}

export const fixtureAccount = "0".repeat(32);

/** A denied call poisons the run even if a dependency catches its rejection. */
export function declarationFetch(zoneName: string): { fetch: typeof fetch; assertAllowed(): void } {
  let denied = false;
  const reject = (): never => { denied = true; throw new Error("Native inventory denied an unexpected request"); };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    let url: URL;
    try { url = new URL(request?.url ?? String(input)); } catch { return reject(); }
    if ((init?.method ?? request?.method ?? "GET") !== "GET" || init?.body != null || request?.body != null ||
      url.protocol !== "https:" || url.hostname !== "api.cloudflare.com" || url.port !== "" || url.username || url.password || url.hash)
      return reject();
    let result: unknown;
    if (url.pathname === "/client/v4/zones") {
      const expected = new Map([["account.id", fixtureAccount], ["name", zoneName], ["per_page", "1"]]);
      if ([...url.searchParams].length !== expected.size || [...expected].some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value))
        return reject();
      result = [{ id: "1".repeat(32), name: zoneName, account: { id: fixtureAccount } }];
    } else if (url.pathname === `/client/v4/accounts/${fixtureAccount}/workers/scripts` && !url.search) {
      result = [];
    } else return reject();
    const count = Array.isArray(result) ? result.length : 0;
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result,
      result_info: { page: 1, per_page: 100, count, total_count: count, total_pages: 1 } }),
    { headers: { "content-type": "application/json" } });
  };
  return { fetch, assertAllowed() { if (denied) reject(); } };
}
