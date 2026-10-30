import { inventoryFailure, inventoryRecord } from "./inventory-record.ts";

const keys = ["computer-registry-v1", "pool-directory-v1", "pool-control-v1"];
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid inventory storage");
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error("Invalid inventory identifier");
  return value;
};
const optionalId = (value: unknown) => value === undefined ? null : id(value);
const numericId = (value: unknown) => {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) throw new Error("Invalid inventory identifier");
  return value;
};
const ids = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("Invalid inventory identifiers");
  return value.map(id);
};
const entries = (value: unknown) => {
  const result = Object.entries(object(value));
  if (result.length > 1_000) throw new Error("Inventory limit exceeded");
  return result;
};

export function poolStorageSnapshot(stored: ReadonlyMap<string, unknown>) {
  const registry = stored.get(keys[0]!);
  const directory = stored.get(keys[1]!);
  const control = stored.get(keys[2]!);
  const computers = registry === undefined ? null : entries(registry).map(([, raw]) => {
    const value = object(raw);
    return { id: id(value.id), user: id(value.user), pool: id(value.pool),
      state: id(value.state), keyId: numericId(value.keyId), userId: numericId(value.userId),
      toolsKeyId: id(value.toolsKeyId), switching: ids(value.switching ?? []), switchingTo: optionalId(value.switchingTo) };
  });
  const pools = directory === undefined ? null : entries(object(directory).pools).map(([, raw]) => {
    const value = object(raw);
    return { pool: id(value.pool), owner: id(value.owner), organization: id(value.organization),
      users: ids(value.users), pending: ids(value.pending), provisioned: ids(value.provisioned ?? []),
      deleted: value.deleted === true };
  });
  const attribution = control === undefined ? null : (() => {
    const value = object(control);
    return {
      assigned: ids(value.assigned),
      locks: entries(value.locks).map(([provider, raw]) => {
        const lock = object(raw);
        return { provider: id(provider), pool: id(lock.pool), snapshot: ids(lock.snapshot),
          unconfirmedUploads: ids(lock.unconfirmedUploads ?? []) };
      }),
      sessions: entries(value.sessions).map(([, raw]) => {
        const tracked = object(raw);
        const session = object(tracked.session);
        return { pool: id(session.pool), provider: id(session.provider), accountId: optionalId(tracked.accountId),
          pendingIds: ids(tracked.pendingIds ?? []) };
      }),
      uploads: entries(value.uploads ?? {}).map(([, raw]) => {
        const upload = object(raw);
        return { pool: id(upload.pool), id: id(upload.id), assigned: upload.assigned === true };
      }),
    };
  })();
  return { snapshot: new Date().toISOString(), computers, pools, attribution,
    absentKeys: keys.filter((key) => !stored.has(key)) };
}

export async function reportPoolStorage(storage: { get<T>(keys: string[]): Promise<Map<string, T>> }): Promise<void> {
  try {
    const stored = await storage.get<unknown>(keys);
    inventoryRecord("pool-storage-v1", poolStorageSnapshot(stored), keys);
  } catch {
    inventoryFailure("pool-storage-v1");
  }
}
