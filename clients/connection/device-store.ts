interface DeviceStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
const stores = new WeakMap<DeviceStore, DeviceStore>();

/** Cancelling a waiter cannot undo a native write. Later sign-in/removal must run after it. */
export function orderedDeviceStore(storage: DeviceStore): DeviceStore {
  const existing = stores.get(storage);
  if (existing) return existing;
  let mutations = Promise.resolve();
  const mutate = (action: () => Promise<void>) => {
    const result = mutations.then(action);
    mutations = result.catch(() => {});
    return result;
  };
  const ordered: DeviceStore = {
    read: async () => {
      await mutations;
      return storage.read();
    },
    write: (value) => mutate(() => storage.write(value)),
    remove: () => mutate(() => storage.remove()),
  };
  stores.set(storage, ordered);
  stores.set(ordered, ordered);
  return ordered;
}
