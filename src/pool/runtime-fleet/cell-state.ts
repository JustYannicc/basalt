import type { ControllerState } from "../runtime-slots/runtime-state.ts";
import {
  nativeMembershipKey,
  slotFirstStartKey,
  type SlotStorage,
} from "../runtime-slots/storage.ts";

export function runtimeCellKey(cell: string, value: string) {
  if (!/^[a-zA-Z0-9-]{1,128}$/u.test(cell)) throw new Error("Invalid runtime cell");
  return value === nativeMembershipKey ? value : `runtime-fleet-v1:cell:${cell}:${value}`;
}

/** Cells have independent handoff journals but read the existing canonical membership authority. */
export function runtimeCellState(
  root: ControllerState,
  cell: string,
  authorizeStart?: (transaction: SlotStorage) => Promise<void>,
): ControllerState {
  const key = (value: string) => runtimeCellKey(cell, value);
  const scoped = (storage: SlotStorage): SlotStorage => ({
    get: <T>(value: string) => storage.get<T>(key(value)),
    put: async (value, content) => {
      if (value === nativeMembershipKey) throw new Error("Runtime cells cannot write membership");
      // The root permission and first dispatch intent share this transaction with fleet-disable.
      if (value === slotFirstStartKey && (await storage.get(key(value))) === undefined)
        await authorizeStart?.(storage);
      return storage.put(key(value), content);
    },
  });
  return {
    id: root.id,
    storage: {
      ...scoped(root.storage),
      put: async <T>(value: string, content: T) => {
        await scoped(root.storage).put(value, content);
      },
      transaction: (work) => root.storage.transaction((transaction) => work(scoped(transaction))),
      getAlarm: () => root.storage.getAlarm(),
      setAlarm: (at) => root.storage.setAlarm(at),
    },
    waitUntil: (work) => root.waitUntil(work),
  };
}
