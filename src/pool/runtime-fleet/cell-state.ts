import type { ControllerState } from "../runtime-slots/runtime-state.ts";
import { nativeMembershipKey, type SlotStorage } from "../runtime-slots/storage.ts";

/** Cells have independent handoff journals but read the existing canonical membership authority. */
export function runtimeCellState(root: ControllerState, cell: string): ControllerState {
  if (!/^[a-zA-Z0-9-]{1,128}$/u.test(cell)) throw new Error("Invalid runtime cell");
  const prefix = `runtime-fleet-v1:cell:${cell}:`;
  const key = (value: string) => (value === nativeMembershipKey ? value : `${prefix}${value}`);
  const scoped = (storage: SlotStorage): SlotStorage => ({
    get: <T>(value: string) => storage.get<T>(key(value)),
    put: (value, content) => {
      if (value === nativeMembershipKey) throw new Error("Runtime cells cannot write membership");
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
