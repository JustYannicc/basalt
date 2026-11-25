/**
 * What every rehearsal stage still holds, from its own State rows: lanes by lane number, the
 * four-digit stages by ordinal (as `retire` counts them). For a whole stage, the provider is read
 * for what bills while it stands: its container's instances and its Postgres branches. Read only.
 */
import type { NumberedStageRows } from "../preview/inventory.ts";

const buckets = "Cloudflare.R2.Bucket";
const database = "Planetscale.PostgresDatabase";

export function classify({ stacks, unreadable }: NumberedStageRows) {
  if (unreadable) return "unreadable";
  const kinds = new Set(
    Object.values(stacks)
      .flatMap((byKind) => Object.keys(byKind))
      .filter((kind) => kind !== "output"),
  );
  if (!kinds.size) return "empty";
  if ([...kinds].every((kind) => kind === buckets)) return "buckets-only";
  if ([...kinds].every((kind) => kind === database || kind === buckets))
    return kinds.has(buckets) ? "buckets and database" : "database-only";
  return "whole";
}

export interface ProviderReads {
  /** A container application's instances as the provider reports them, or absent. */
  application(id: string): Promise<{ configured?: number; active?: number } | "absent">;
  /** Whether a Postgres branch exists, with its state, or absent. */
  branch(database: string, name: string): Promise<{ state: string } | "absent">;
}

const failure = (error: unknown) => (error instanceof Error ? error.constructor.name : "error");

/** One public line per stage: no stage name for a four-digit stage, and no ids. */
export async function stageTable(stages: readonly NumberedStageRows[], reads: ProviderReads) {
  const lines: string[] = [];
  let ordinal = 0;
  for (const stage of stages) {
    const lane = /^test-rehearsal-([1-9])$/u.exec(stage.stage)?.[1];
    const label = lane ? `lane ${lane}` : `stage ${++ordinal}`;
    const kind = classify(stage);
    const counts =
      Object.entries(stage.stacks)
        .map(
          ([stack, byKind]) =>
            `${stack}: ${
              Object.entries(byKind)
                .map(([name, count]) => `${name} ${count}`)
                .join(", ") || "none"
            }`,
        )
        .join("; ") || "no rows";
    const facts: string[] = [];
    if (kind === "whole") {
      for (const id of stage.containers ?? []) {
        const read = await reads.application(id).catch((error: unknown) => failure(error));
        facts.push(
          read === "absent"
            ? "container application gone"
            : typeof read === "string"
              ? `container unreadable (${read})`
              : `container ${read.configured ?? "?"} instance(s) configured, ${read.active ?? "?"} active`,
        );
      }
      const branches = await Promise.all(
        (stage.branches ?? []).map((branch) =>
          reads.branch(branch.database, branch.name).catch((error: unknown) => failure(error)),
        ),
      );
      if (branches.length)
        facts.push(
          `Postgres branches: ${branches.filter((read) => typeof read === "object").length} of ${branches.length} exist` +
            (branches.some((read) => typeof read === "string" && read !== "absent")
              ? " (some unreadable)"
              : ""),
        );
    }
    lines.push(`  ${label}: ${kind}; ${counts}${facts.length ? `; ${facts.join("; ")}` : ""}`);
  }
  return lines;
}
