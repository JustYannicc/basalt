import type { ComputerStorage, StoredComputer } from "./computer-registry.ts";
import { PoolDirectory } from "./directory.ts";
import { fail } from "./json.ts";

/** Listing names does not let this grant switch pools or use models it was not granted. */
export async function nativePoolDisplay(
  storage: ComputerStorage,
  computer: StoredComputer,
  now: number,
) {
  const directory = await PoolDirectory.load(storage, now);
  const current = directory.entry(computer.pool);
  if (!current) return fail(403, "unauthorized", "This pool is no longer available.");
  const name = (value: string, mine: boolean) =>
    value.trim() || (mine ? "Your pool" : "Shared pool");
  const pools = computer.native?.models
    ? directory
        .choices(computer.user, now, current)
        .filter((choice) => directory.entry(choice.id)?.users.includes(computer.user))
        .map((choice) => ({ id: choice.id, name: name(choice.name, choice.mine) }))
    : [];
  return {
    pool: { id: current.pool, name: name(current.name, current.owner === computer.user) },
    pools,
  };
}
