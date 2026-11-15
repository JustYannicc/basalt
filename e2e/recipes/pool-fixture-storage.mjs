/** Native storage operations used by the real pool controllers and revision source. */
export function poolFixtureStorage(values = new Map()) {
  const operations = (entries) => ({
    async get(key) {
      if (Array.isArray(key))
        return new Map(
          key
            .filter((name) => entries.has(name))
            .map((name) => [name, structuredClone(entries.get(name))]),
        );
      return structuredClone(entries.get(key));
    },
    async put(key, value) {
      for (const [name, saved] of typeof key === "string" ? [[key, value]] : Object.entries(key))
        entries.set(name, structuredClone(saved));
    },
    async delete(key) {
      return Array.isArray(key)
        ? key.filter((name) => entries.delete(name)).length
        : entries.delete(key);
    },
  });
  let pending = Promise.resolve();
  const commit = (work) => {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  };
  const current = operations(values);
  return {
    ...current,
    put: (key, value) => commit(() => current.put(key, value)),
    delete: (key) => commit(() => current.delete(key)),
    transaction(work) {
      return commit(async () => {
        const candidate = structuredClone(values);
        const result = await work(operations(candidate));
        values.clear();
        for (const [key, value] of candidate) values.set(key, value);
        return result;
      });
    },
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
  };
}
