import type { HomeClient } from "./control.ts";
import { object, unavailable, type Json } from "./json.ts";

const families = new Set([
  "codex",
  "claude",
  "gemini",
  "vertex",
  "xai",
  "meta",
  "openai-compatibility",
]);
const pending = new WeakMap<HomeClient, Promise<void>>();

function sorted(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    object(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

function keys(group: Json): Json[] {
  if (!Array.isArray(group.keys) || !group.keys.every(object)) return unavailable();
  return group.keys;
}

function effective(groups: Json[], family: string): Map<string, string> {
  const compatible = family === "openai-compatibility";
  // Home rebuilds these typed keys with non-omitempty fields before exporting v8 groups.
  const defaults =
    family === "codex" || family === "claude"
      ? { "base-url": "", "proxy-url": "", models: [] }
      : {};
  const result = new Map<string, string>();
  for (const group of groups) {
    const { keys: _keys, name, ...shared } = group;
    for (const key of keys(group)) {
      if (typeof key.id !== "string" || result.has(key.id)) return unavailable();
      const overrides = Object.fromEntries(
        Object.entries(key).filter(([, value]) => value !== null),
      );
      result.set(
        key.id,
        sorted({ ...defaults, ...shared, ...(compatible ? { name } : {}), ...overrides }),
      );
    }
  }
  return result;
}

async function read(home: HomeClient, path: string, signal: AbortSignal): Promise<Json[]> {
  const response = await home.response(path, { signal });
  if (response.status === 404) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) {
    await response.body?.cancel();
    return unavailable();
  }
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every(object)) return unavailable();
  return value;
}

/** Home replaces a whole family. Serialize through the one client owned by the pool DO. */
function serialized(home: HomeClient, work: () => Promise<void>): Promise<void> {
  const previous = pending.get(home) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  pending.set(home, run);
  return run.finally(() => {
    if (pending.get(home) === run) pending.delete(home);
  });
}

/** Write a family whose only intended change is `reference`, then prove that from a fresh read. */
async function replaceFamily(
  home: HomeClient,
  family: string,
  reference: string,
  next: (before: Json[]) => Json[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const path = `/config/api-keys/${family}`;
  const before = await read(home, path, signal);
  const retained = effective(before, family);
  const groups = next(before);
  const expected = effective(groups, family);
  for (const [id, value] of retained) {
    if (id !== reference && expected.get(id) !== value) return unavailable();
  }
  if (
    retained.size !== expected.size ||
    [...expected].some(([id, value]) => retained.get(id) !== value)
  ) {
    try {
      const response = await home.response(path, {
        method: "PUT",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(groups),
      });
      await response.body?.cancel();
    } catch {
      signal.throwIfAborted();
      // A lost write reply is resolved by the authoritative read below.
    }
  }
  const actual = effective(await read(home, path, signal), family);
  if (
    actual.size !== expected.size ||
    [...expected].some(([id, value]) => actual.get(id) !== value)
  )
    return unavailable();
}

function without(groups: Json[], reference: string): Json[] {
  return groups.flatMap((group) => {
    const existing = keys(group);
    if (!existing.some((key) => key.id === reference)) return [group];
    const remaining = existing.filter((key) => key.id !== reference);
    return remaining.length ? [{ ...group, keys: remaining }] : [];
  });
}

/**
 * `proxy` is the credential's route setting from RouteAssignments; undefined keeps the host's.
 * It is written on the key so a re-mirror never drops a routed credential back to direct.
 */
export async function mirrorHomeConfig(
  home: HomeClient,
  reference: string,
  action: string,
  credential: Json,
  signal: AbortSignal,
  proxy?: string,
): Promise<void> {
  const family = credential.family;
  if (typeof family !== "string" || !families.has(family)) return unavailable();
  const compatible = family === "openai-compatibility";
  if (action === "upsert") {
    if (typeof credential.token !== "string" || !credential.token || !object(credential.group))
      return unavailable();
    const group = credential.group;
    if (
      "keys" in group ||
      (compatible &&
        (typeof group.name !== "string" ||
          !group.name ||
          typeof group["base-url"] !== "string" ||
          !Array.isArray(group.models) ||
          !group.models.length))
    )
      return unavailable();
  }
  await serialized(home, () =>
    replaceFamily(
      home,
      family,
      reference,
      (before) => {
        const next = without(before, reference);
        if (action === "upsert") {
          const key: Json = { id: reference, "api-key": credential.token as string };
          if (proxy !== undefined) key["proxy-url"] = proxy;
          next.push({ ...(credential.group as Json), keys: [key] });
        }
        return next;
      },
      signal,
    ),
  );
}

/** Every mirrored API key's current route setting, by reference. */
export async function readHomeConfigProxies(
  home: HomeClient,
  signal: AbortSignal,
): Promise<Map<string, { family: string; proxy: string }>> {
  const result = new Map<string, { family: string; proxy: string }>();
  for (const family of families) {
    const groups = await read(home, `/config/api-keys/${family}`, signal);
    for (const [id, value] of effective(groups, family)) {
      const proxy: unknown = (JSON.parse(value) as Json)["proxy-url"];
      result.set(id, { family, proxy: typeof proxy === "string" ? proxy : "" });
    }
  }
  return result;
}

/** Change one key's route setting and nothing else, proven by the same family read-back. */
export function setHomeConfigProxy(
  home: HomeClient,
  family: string,
  reference: string,
  proxy: string,
  signal: AbortSignal,
): Promise<void> {
  if (!families.has(family)) return unavailable();
  return serialized(home, () =>
    replaceFamily(
      home,
      family,
      reference,
      (before) => {
        if (!before.some((group) => keys(group).some((key) => key.id === reference)))
          return unavailable();
        return before.map((group) =>
          keys(group).some((key) => key.id === reference)
            ? {
                ...group,
                keys: keys(group).map((key) =>
                  key.id === reference ? { ...key, "proxy-url": proxy } : key,
                ),
              }
            : group,
        );
      },
      signal,
    ),
  );
}
