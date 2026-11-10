import type { ComputerStorage, StoredComputer } from "./computer-registry.ts";
import { PoolDirectory } from "./directory.ts";
import { fail } from "./json.ts";
import { labelPools, type Team } from "./team-labels.ts";

/**
 * Listing names does not let this grant switch pools or use models it was not granted.
 * `teams` comes from the tools service's signed check, so pools from teams the person left drop
 * out; the grant's own pool always stays, since the check already authorized it.
 */
export async function nativePoolDisplay(
  storage: ComputerStorage,
  computer: StoredComputer,
  now: number,
  teams?: readonly Team[],
) {
  const directory = await PoolDirectory.load(storage, now);
  const current = directory.entry(computer.pool);
  if (!current) return fail(403, "unauthorized", "This pool is no longer available.");
  const listed = (
    computer.native?.models ? directory.choices(computer.user, now, current) : []
  ).filter((choice) => directory.entry(choice.id)?.users.includes(computer.user));
  const own = {
    id: current.pool,
    name: current.name,
    mine: current.owner === computer.user,
    ...(current.organization && { organization: current.organization }),
  };
  const labelled = labelPools(
    listed.some((choice) => choice.id === own.id) ? listed : [own, ...listed],
    teams,
    own.id,
  );
  const label = new Map(labelled.map((pool) => [pool.id, pool.label]));
  return {
    pool: { id: own.id, name: label.get(own.id) ?? own.name },
    pools: listed.flatMap(({ id }) => {
      const name = label.get(id);
      return name === undefined ? [] : [{ id, name }];
    }),
  };
}
