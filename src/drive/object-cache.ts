import { DriveError, type GitObject, type ObjectStore } from "./shared/index.ts";

/** The byte allowance counts object payloads. Canonical objects always remain in R2. */
export function cacheObjects(objects: ObjectStore, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new DriveError(
      "invalid",
      "The disposable cache allowance must be a non-negative integer",
    );
  const entries = new Map<string, GitObject>();
  let bytes = 0,
    hits = 0,
    misses = 0,
    evictions = 0;
  const copy = (object: GitObject): GitObject => ({ ...object, content: object.content.slice() });
  const remember = (object: GitObject) => {
    if (object.content.length > limit) return;
    const previous = entries.get(object.oid);
    if (previous) {
      bytes -= previous.content.length;
      entries.delete(object.oid);
    }
    while (bytes + object.content.length > limit && entries.size) {
      const oldest = entries.entries().next().value;
      if (!oldest) break;
      entries.delete(oldest[0]);
      bytes -= oldest[1].content.length;
      evictions++;
    }
    entries.set(object.oid, copy(object));
    bytes += object.content.length;
  };
  const cached: ObjectStore = {
    async get(oid) {
      const known = entries.get(oid);
      if (known) {
        hits++;
        entries.delete(oid);
        entries.set(oid, known);
        return copy(known);
      }
      misses++;
      const object = await objects.get(oid);
      if (object) remember(object);
      return object;
    },
    async put(batch) {
      await objects.put(batch);
      for (const object of batch) remember(object);
    },
  };
  return {
    objects: cached,
    clear() {
      entries.clear();
      bytes = 0;
    },
    status: () => ({ bytes, limit, objects: entries.size, hits, misses, evictions }),
  };
}
