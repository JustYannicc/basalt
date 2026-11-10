import { record, SetupError, text } from "./session.ts";

/** A pool the browser may pick: only what the picker shows, never who else uses it. */
export interface PoolPick {
  readonly id: string;
  readonly name: string;
  readonly mine: boolean;
  readonly label: string;
}

/** A team the signed-in person belongs to, as the tools service lists it for their own session. */
export interface Team {
  readonly id: string;
  readonly name: string;
}

export function teamsOf(listed: readonly Record<string, unknown>[] | undefined): Team[] | undefined {
  return listed?.flatMap((team) =>
    text(team.id, 512) ? [{ id: team.id, name: typeof team.name === "string" ? team.name.trim() : "" }] : []);
}

/**
 * The pool Worker lists every pool it last saw the person in, including pools in teams they have
 * since left or deleted. Only the person's current teams count, so with their team list a pool from
 * any other team is dropped. Without it (the list failed, or an older Worker sent no team), pools
 * stay listed and the pool Worker still authorizes every pick.
 */
export function poolPicks(value: unknown, teams: readonly Team[] | undefined): PoolPick[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SetupError(502, "Setup service returned invalid pools.");
  const team = new Map(teams?.map((entry) => [entry.id, entry.name]));
  const seen = new Set<string>();
  const kept = value.flatMap((entry) => {
    const input = record(entry);
    if (!text(input.id, 512) || typeof input.name !== "string" || input.name.length > 200 || typeof input.mine !== "boolean"
      || (input.organization !== undefined && !text(input.organization, 512)))
      throw new SetupError(502, "Setup service returned invalid pools.");
    // The pool Worker keys pools by id; this only guards a reply that repeats one.
    if (seen.has(input.id)) return [];
    seen.add(input.id);
    const organization = typeof input.organization === "string" ? input.organization : undefined;
    if (teams && organization !== undefined && !team.has(organization)) return [];
    const name = input.name.trim() || (input.mine ? "Your pool" : "Shared pool");
    const teamName = organization === undefined ? "" : team.get(organization) ?? "";
    return [{ id: input.id, name: input.name, mine: input.mine, base: teamName ? `${name} · ${teamName}` : name }];
  });
  // Two pools with the same name in the same team still need labels a person can tell apart.
  const counts = new Map<string, number>();
  for (const pick of kept) counts.set(pick.base, (counts.get(pick.base) ?? 0) + 1);
  const nth = new Map<string, number>();
  return kept.map(({ base, ...pick }) => {
    if (counts.get(base)! < 2) return { ...pick, label: base };
    const n = (nth.get(base) ?? 0) + 1;
    nth.set(base, n);
    return { ...pick, label: `${base} (${n})` };
  });
}
