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
  let pending = Promise.resolve();
  const next = <T>(action: () => Promise<T>) => {
    const result = pending.then(action);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const ordered: DeviceStore = {
    read: () => next(() => storage.read()),
    write: (value) => next(() => storage.write(value)),
    remove: () => next(() => storage.remove()),
  };
  stores.set(storage, ordered);
  stores.set(ordered, ordered);
  return ordered;
}
