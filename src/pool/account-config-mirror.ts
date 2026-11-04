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
export async function mirrorHomeConfig(
  home: HomeClient,
  reference: string,
  action: string,
  credential: Json,
  signal: AbortSignal,
): Promise<void> {
  const previous = pending.get(home) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      const family = credential.family;
      if (typeof family !== "string" || !families.has(family)) return unavailable();
      const path = `/config/api-keys/${family}`;
      const compatible = family === "openai-compatibility";
      const before = await read(home, path, signal);
      const retained = effective(before, family);
      const next = before.flatMap((group) => {
        const existing = keys(group);
        if (!existing.some((key) => key.id === reference)) return [group];
        const remaining = existing.filter((key) => key.id !== reference);
        return remaining.length ? [{ ...group, keys: remaining }] : [];
      });
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
        next.push({ ...group, keys: [{ id: reference, "api-key": credential.token }] });
      }
      const expected = effective(next, family);
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
            body: JSON.stringify(next),
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
    });
  pending.set(home, run);
  try {
    await run;
  } finally {
    if (pending.get(home) === run) pending.delete(home);
  }
}
