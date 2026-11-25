/**
 * Retires the four-digit rehearsal stages left from before rehearsals ran on lanes, one per run,
 * through the lane's own destroy and absence check. A stage is taken only once its own rows prove
 * it is its own: every Postgres database row names the stage's derived database, every name a
 * provider object carries is the stage's, and no id or name it records is one production's State
 * records. A stage that fails the proof is left, named by its kinds, and the next one is taken.
 */
import { deployment } from "../../brand.ts";
import type { NumberedStageRows, PreviewStateEntry } from "../preview/inventory.ts";
import { subjectFromStage, type StageSubject } from "../preview/subject.ts";

/**
 * One public line per numbered stage, by ordinal: its kinds, and whether this mode may take it.
 * `candidates` are the stages it may take, in order; a run retires the first one whose rows pass
 * the ownership proof, so one it refuses never blocks the rest.
 */
export function retirePlan(stages: readonly NumberedStageRows[]) {
  const lines: string[] = [];
  const candidates: { ordinal: number; stage: string }[] = [];
  for (const [index, { stage, stacks, unreadable }] of stages.entries()) {
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
    const verdict = unreadable ? "left: its State could not be read" : "retirable";
    if (!unreadable) candidates.push({ ordinal: index + 1, stage });
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

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Shared with production by design: retained or never written, so never this stage's to prove.
const SHARED_TYPES = /^Cloudflare\.(?:SecretsStore|MtlsCertificate)/u;
// Account-wide ids and names every row of an account shares with production.
const SHARED_KEYS = new Set(["accountId", "zoneId", "zoneName", "storeId", "organizationId"]);
// What names a provider object; a class name names none, and is shared with production by design.
const isNameKey = (key: string) =>
  key !== "className" &&
  !SHARED_KEYS.has(key) &&
  (key === "name" || key === "hostname" || key === "title" || /^[a-z][A-Za-z]*Name$/u.test(key));
const isIdKey = (key: string) =>
  !SHARED_KEYS.has(key) && /^(?:id|uuid|[a-z][A-Za-z]*Id)$/u.test(key);
// Rows that write nothing to a provider: Alchemy's own values, and commands run on the runner.
const LOCAL_TYPES = /^(?:Alchemy|Command)\./u;

/**
 * The names Alchemy gives an unnamed resource under the rehearsal stack and this stage, from the
 * row's own id and instance: each provider's length limit and case. A name cut to its limit keeps
 * only a hash of the stack, stage, id and instance, so only this row's own cut name matches.
 */
async function derivedNames(id: string, instanceId: string, stage: string) {
  const { createPhysicalName } = await import("alchemy/PhysicalName");
  const { StackContext } = await import("alchemy/StackContext");
  const { Stage } = await import("alchemy/Stage");
  const { InstanceId } = await import("alchemy/InstanceId");
  const { Effect } = await import("effect");
  const names: string[] = [];
  for (const maxLength of [64, 63])
    for (const lowercase of [true, false]) {
      const name = await Effect.runPromise(
        createPhysicalName({ id, instanceId, maxLength, lowercase }).pipe(
          Effect.provideService(StackContext, { name: "basalt-rehearsal" } as never),
          Effect.provideService(Stage, stage),
          Effect.provideService(InstanceId, instanceId),
        ),
      );
      names.push(name, name.toLowerCase());
    }
  return names;
}

/**
 * Proves from a whole stage's rows that everything a destroy would delete is the stage's own.
 * - A name that writes any rehearsal stage whole must write this one.
 * - A name that writes no stage must be this row's own name as Alchemy derives it for this stage
 *   (cut to its limit, it keeps a hash of the stage), or a hostname under the stage's own host.
 * - A Worker's zone routes must sit under the stage's own host.
 * - A Postgres row must live in the stage's derived database.
 * - No id or name of a provider object may be one production's own State records.
 * - A row of any other provider is refused: nothing here proves it, and the stage gate would refuse
 *   its delete anyway.
 * Says which kind and attribute failed, never a value.
 */
export async function ownershipRefusal(
  rows: readonly PreviewStateEntry[],
  stage: string,
  stageDatabase: string,
  production: ReadonlySet<string>,
): Promise<string | undefined> {
  const slug = stage.slice("test-".length);
  const token = new RegExp(`(?:^|-)${stage}(?:-|$)`, "u");
  const anyStage = /(?:^|-)test-rehearsal-[0-9]+(?:-|$)/u;
  const ownHost = (host: string) =>
    host === slug || host.startsWith(`${slug}.`) || host.includes(`.${slug}.`);
  for (const { value } of rows) {
    if (!record(value)) continue;
    const type = String(value.resourceType ?? "");
    if (SHARED_TYPES.test(type) || LOCAL_TYPES.test(type)) continue;
    const attr = record(value.attr) ? value.attr : {};
    if (type.startsWith("Planetscale.")) {
      const database = typeof attr.database === "string" ? attr.database : attr.name;
      if (database !== stageDatabase)
        return `a ${type} row lives outside this stage's own database`;
      continue;
    }
    if (!type.startsWith("Cloudflare.")) return `a ${type} row is of a kind this path cannot prove`;
    const strings = Object.entries(attr).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    );
    if (strings.some(([key, named]) => (isIdKey(key) || isNameKey(key)) && production.has(named)))
      return `a ${type} row records an id or name production's State records`;
    let derived: string[] | undefined;
    for (const [key, named] of strings) {
      if (!isNameKey(key)) continue;
      if (anyStage.test(named)) {
        if (!token.test(named))
          return `a ${type} row names an object that is not this stage's (${key})`;
        continue;
      }
      if (ownHost(named)) continue;
      const id = typeof value.logicalId === "string" ? value.logicalId : "";
      const instanceId = typeof value.instanceId === "string" ? value.instanceId : "";
      derived ??= id && instanceId ? await derivedNames(id, instanceId, stage) : [];
      if (!derived.includes(named))
        return `a ${type} row names an object that is not this stage's (${key})`;
    }
    if (Array.isArray(attr.routes))
      for (const route of attr.routes) {
        const host =
          record(route) && typeof route.pattern === "string"
            ? route.pattern.split("/")[0]!.replace(/^\*\.?/u, "")
            : "";
        const id = record(route) && typeof route.id === "string" ? route.id : "";
        if (!ownHost(host) || (id && production.has(id)))
          return `a ${type} row routes traffic that is not this stage's (routes)`;
      }
  }
  return undefined;
}
