// The mock's Durable Object storage as the send record uses it, in memory: keys kept in their order.
import type { MockSend, SendStorage } from "../sends.ts";

export function memorySendStorage() {
  const rows = new Map<string, MockSend>();
  const storage: SendStorage & { rows: Map<string, MockSend> } = {
    rows,
    put: async (key, value) => {
      rows.set(key, value);
    },
    list: async ({ prefix, startAfter, limit }) => {
      const keys = [...rows.keys()]
        .filter((key) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .sort()
        .slice(0, limit);
      return new Map(keys.map((key) => [key, rows.get(key)]));
    },
  };
  return storage;
}
