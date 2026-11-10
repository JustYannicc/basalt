import { object } from "./json.ts";

/** A team the person currently belongs to, as the tools service lists it for their own session. */
export interface Team {
  readonly id: string;
  readonly name: string;
}

interface Listed {
  readonly id: string;
  readonly name: string;
  readonly mine: boolean;
  readonly organization?: string;
}

/**
 * The pool Worker keeps every pool it last saw the person in, including pools in teams they have
 * since left or deleted, and only the tools service knows their current teams. With that list a
 * pool from any other team is dropped, unless `keep` names it. Without it, or for a pool with no
 * known team, pools stay listed: the pool Worker still authorizes every pick.
 * Each kept pool is labelled "<pool name> · <team>", numbered when two labels would still match.
 */
export function labelPools<T extends Listed>(
  pools: readonly T[],
  teams: readonly Team[] | undefined,
  keep?: string,
): (T & { readonly label: string })[] {
  const team = new Map(teams?.map((entry) => [entry.id, entry.name.trim()]));
  const kept = pools.flatMap((pool) => {
    const known = pool.organization === undefined ? undefined : team.get(pool.organization);
    if (teams && pool.organization !== undefined && known === undefined && pool.id !== keep)
      return [];
    const name = pool.name.trim() || (pool.mine ? "Your pool" : "Shared pool");
    return [{ pool, base: known ? `${name} · ${known}` : name }];
  });
  const counts = new Map<string, number>();
  for (const { base } of kept) counts.set(base, (counts.get(base) ?? 0) + 1);
  const nth = new Map<string, number>();
  return kept.map(({ pool, base }) => {
    if ((counts.get(base) ?? 0) < 2) return { ...pool, label: base };
    const n = (nth.get(base) ?? 0) + 1;
    nth.set(base, n);
    return { ...pool, label: `${base} (${n})` };
  });
}

/** The signed check's team list; anything malformed means the teams are unknown, not empty. */
export function signedTeams(value: unknown): Team[] | undefined {
  if (!Array.isArray(value) || value.length > 500) return undefined;
  const teams: Team[] = [];
  for (const entry of value) {
    if (!object(entry)) return undefined;
    const { id, name } = entry;
    if (typeof id !== "string" || !id || id.length > 512) return undefined;
    if (typeof name !== "string" || name.length > 200) return undefined;
    teams.push({ id, name });
  }
  return teams;
}
