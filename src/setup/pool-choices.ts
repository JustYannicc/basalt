import { labelPools, type Team } from "../pool/team-labels.ts";
import { record, SetupError, text } from "./session.ts";

/** A pool the browser may pick: only what the picker shows, never who else uses it. */
export interface PoolPick {
  readonly id: string;
  readonly name: string;
  readonly mine: boolean;
  readonly label: string;
}

export function teamsOf(
  listed: readonly Record<string, unknown>[] | undefined,
): Team[] | undefined {
  return listed?.flatMap((team) =>
    text(team.id, 512)
      ? [{ id: team.id, name: typeof team.name === "string" ? team.name.trim() : "" }]
      : [],
  );
}

export function poolPicks(value: unknown, teams: readonly Team[] | undefined): PoolPick[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SetupError(502, "Setup service returned invalid pools.");
  const seen = new Set<string>();
  const listed = value.flatMap((entry) => {
    const input = record(entry);
    if (
      !text(input.id, 512) ||
      typeof input.name !== "string" ||
      input.name.length > 200 ||
      typeof input.mine !== "boolean" ||
      (input.organization !== undefined && !text(input.organization, 512))
    )
      throw new SetupError(502, "Setup service returned invalid pools.");
    // The pool Worker keys pools by id; this only guards a reply that repeats one.
    if (seen.has(input.id)) return [];
    seen.add(input.id);
    const organization = typeof input.organization === "string" ? input.organization : undefined;
    return [
      { id: input.id, name: input.name, mine: input.mine, ...(organization && { organization }) },
    ];
  });
  return labelPools(listed, teams).map(({ id, name, mine, label }) => ({ id, name, mine, label }));
}
