/**
 * Retires the four-digit rehearsal stages left from before rehearsals ran on lanes, one per run,
 * through the lane's own destroy and absence check. Only a stage whose State holds nothing but R2
 * buckets and its own Postgres database is taken. Any other kind stops it before anything is
 * deleted: a whole stage's Hyperdrive configs, Workflows and database branches are not deletable
 * through the release entry, and its certificate is the shared trust root.
 */
import { deployment } from "../../brand.ts";
import type { NumberedStageRows, PreviewStateEntry } from "../preview/inventory.ts";
import { subjectFromStage, type StageSubject } from "../preview/subject.ts";

export const retirableKinds: ReadonlySet<string> = new Set([
  "Cloudflare.R2.Bucket",
  "Planetscale.PostgresDatabase",
  "output",
]);

/**
 * One public line per numbered stage, by ordinal: its kinds, and whether this mode may take it.
 * `candidates` are the stages it may take, in order; a run retires the first one whose rows pass
 * the database proof, so one it refuses never blocks the rest.
 */
export function retirePlan(stages: readonly NumberedStageRows[]) {
  const lines: string[] = [];
  const candidates: { ordinal: number; stage: string }[] = [];
  for (const [index, { stage, stacks, unreadable }] of stages.entries()) {
    const kinds = Object.values(stacks).flatMap((byKind) => Object.keys(byKind));
    const others = [...new Set(kinds.filter((kind) => !retirableKinds.has(kind)))].sort();
    const counts = Object.entries(stacks)
      .map(
        ([stack, byKind]) =>
          `${stack}: ${
            Object.entries(byKind)
              .map(([kind, count]) => `${kind} ${count}`)
              .join(", ") || "none"
          }`,
      )
      .join("; ");
    const verdict = unreadable
      ? "left: its State could not be read"
      : others.length
        ? `left: this path cannot delete ${others.join(", ")}`
        : "retirable";
    if (!unreadable && !others.length) candidates.push({ ordinal: index + 1, stage });
    lines.push(`  stage ${index + 1}: ${counts || "no rows"} (${verdict})`);
  }
  return { lines, candidates };
}

/**
 * Proves from the rows that no Postgres database this stage's destroy deletes is production's: the
 * row's recorded name is the one this stage derives, it is not production's, and neither its name
 * nor its id is one production's own State records.
 */
export function databaseRefusal(
  rows: readonly PreviewStateEntry[],
  stageDatabase: string,
  production: readonly { readonly id?: string; readonly name?: string }[],
): string | undefined {
  for (const { value } of rows) {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    if (row.resourceType !== "Planetscale.PostgresDatabase") continue;
    const attr =
      row.attr && typeof row.attr === "object" ? (row.attr as Record<string, unknown>) : {};
    const name = typeof attr.name === "string" ? attr.name : undefined;
    const id = typeof attr.id === "string" ? attr.id : undefined;
    if (!name || name !== stageDatabase || name === deployment.databaseName)
      return "a Postgres database row does not name this stage's own database";
    if (production.some((database) => database.name === name || (id && database.id === id)))
      return "a Postgres database row records one of production's databases";
  }
  return undefined;
}

/** The stage a run retires, as the subject every lane step takes. */
export function retireSubject(stage: string): StageSubject {
  const subject = subjectFromStage(stage);
  if (subject?.kind !== "rehearsal" || !/^test-rehearsal-[1-9][0-9]{3}$/u.test(stage))
    throw new Error("Only a four-digit rehearsal stage is retired");
  return subject;
}
