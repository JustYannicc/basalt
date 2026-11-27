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
import { derivedNames, workflowName, type AlchemyNamers } from "./retire-names.ts";

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

/** The row that refused a stage and what it names. Private output only: it can name any value. */
export type RefusalDetail = {
  readonly path: string;
  readonly type: string | null;
  readonly key: string | null;
  readonly value: string | null;
};
/** Why a stage is left: `line` names a kind and a key only, so it can go public; `detail` cannot. */
export type Refusal = { readonly line: string; readonly detail: RefusalDetail };

const refusal = (
  line: string,
  path: string,
  type: string,
  key: string | null = null,
  value: unknown = null,
): Refusal => ({
  line,
  detail: { path, type: type || null, key, value: typeof value === "string" ? value : null },
});

/**
 * A stack's own output row (`<stack>/<stage>/output`): the values the stack exports, kept apart
 * from its resources. A destroy sends no provider request for it, and its read never lists it.
 */
export const isStackOutput = (path: string) => /^[^/]+\/[^/]+\/output$/u.test(path);

/**
 * Proves from the rows that no Postgres database this stage's destroy deletes is production's: the
 * row's recorded name is the one this stage derives, it is not production's, and neither its name
 * nor its id is one production's own State records.
 */
export function databaseRefusal(
  rows: readonly PreviewStateEntry[],
  stageDatabase: string,
  production: readonly { readonly id?: string; readonly name?: string }[],
): Refusal | undefined {
  for (const entry of rows) {
    const refused = databaseRowRefusal(entry, stageDatabase, production);
    if (refused) return refused;
  }
  return undefined;
}

function databaseRowRefusal(
  { path, value }: PreviewStateEntry,
  stageDatabase: string,
  production: readonly { readonly id?: string; readonly name?: string }[],
): Refusal | undefined {
  if (isStackOutput(path)) return undefined;
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const type = row.resourceType;
  if (type !== "Planetscale.PostgresDatabase") return undefined;
  const attr =
    row.attr && typeof row.attr === "object" ? (row.attr as Record<string, unknown>) : {};
  const name = typeof attr.name === "string" ? attr.name : undefined;
  const id = typeof attr.id === "string" ? attr.id : undefined;
  if (!name || name !== stageDatabase || name === deployment.databaseName)
    return refusal(
      "a Postgres database row does not name this stage's own database",
      path,
      type,
      "name",
      name,
    );
  const line = "a Postgres database row records one of production's databases";
  if (production.some((database) => database.name === name))
    return refusal(line, path, type, "name", name);
  if (id && production.some((database) => database.id === id))
    return refusal(line, path, type, "id", id);
  return undefined;
}

/**
 * Every refusing row of a stage by both proofs, one refusal per row, the database proof's first:
 * what a read-only pass lists. A retire stops at the first instead.
 */
export async function stageRefusals(
  rows: readonly PreviewStateEntry[],
  stage: string,
  stageDatabase: string,
  production: ProductionRecords,
  options: { namers?: AlchemyNamers } = {},
): Promise<Refusal[]> {
  const found = rows.flatMap((entry) => {
    const refused = databaseRowRefusal(entry, stageDatabase, production.databases);
    return refused ? [refused] : [];
  });
  const refusedPaths = new Set(found.map(({ detail }) => detail.path));
  for (const refused of await ownershipRefusals(
    rows,
    stage,
    stageDatabase,
    production.identities,
    options,
  ))
    if (!refusedPaths.has(refused.detail.path)) found.push(refused);
  return found;
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

type Ownership = {
  readonly rows: readonly PreviewStateEntry[];
  readonly stage: string;
  readonly stageDatabase: string;
  readonly production: ReadonlySet<string>;
  readonly namers: AlchemyNamers;
};
const WORKFLOW = "Cloudflare.Workflow";

/**
 * Proves from a whole stage's rows that everything a destroy would delete is the stage's own.
 * - A name that writes any rehearsal stage whole must write this one.
 * - A name that writes no stage must be this row's own name as its provider derives it for this
 *   stage (cut to its limit, it keeps a hash of the stage), or a hostname under the stage's own
 *   host.
 * - An unnamed Workflow's name must be the one Alchemy derives from its host Worker and class, and
 *   that host a Worker row of this stage that proves; its `scriptName` proves by that host.
 * - A Worker's zone routes must sit under the stage's own host.
 * - A Postgres row must live in the stage's derived database.
 * - No id or name of a provider object may be one production's own State records.
 * - A row of any other provider is refused: nothing here proves it, and the stage gate would refuse
 *   its delete anyway.
 * Says which kind and attribute failed, never a value. Stops at the first refusing row.
 */
export async function ownershipRefusal(
  rows: readonly PreviewStateEntry[],
  stage: string,
  stageDatabase: string,
  production: ReadonlySet<string>,
  { namers = {} }: { namers?: AlchemyNamers } = {},
): Promise<Refusal | undefined> {
  const context = { rows, stage, stageDatabase, production, namers };
  for (const entry of rows) {
    const refused = await rowRefusal(entry, context);
    if (refused) return refused;
  }
  return undefined;
}

/** Every refusing row of a stage, one refusal each, for a read-only pass that lists them all. */
export async function ownershipRefusals(
  rows: readonly PreviewStateEntry[],
  stage: string,
  stageDatabase: string,
  production: ReadonlySet<string>,
  { namers = {} }: { namers?: AlchemyNamers } = {},
): Promise<Refusal[]> {
  const context = { rows, stage, stageDatabase, production, namers };
  const refusals: Refusal[] = [];
  for (const entry of rows) {
    const refused = await rowRefusal(entry, context);
    if (refused) refusals.push(refused);
  }
  return refusals;
}

async function rowRefusal(
  { path, value }: PreviewStateEntry,
  context: Ownership,
): Promise<Refusal | undefined> {
  const { rows, stage, stageDatabase, production, namers } = context;
  const slug = stage.slice("test-".length);
  const token = new RegExp(`(?:^|-)${stage}(?:-|$)`, "u");
  const anyStage = /(?:^|-)test-rehearsal-[0-9]+(?:-|$)/u;
  const ownHost = (host: string) =>
    host === slug || host.startsWith(`${slug}.`) || host.includes(`.${slug}.`);
  // The stack's exported outputs: no resource, nothing a destroy deletes, so nothing to prove.
  if (isStackOutput(path) || !record(value)) return undefined;
  const type = String(value.resourceType ?? "");
  if (SHARED_TYPES.test(type) || LOCAL_TYPES.test(type)) return undefined;
  const kind = type ? `a ${type} row` : "a row with no type";
  const refuse = (line: string, key?: string, named?: unknown) =>
    refusal(line, path, type, key ?? null, named);
  const attr = record(value.attr) ? value.attr : {};
  if (type.startsWith("Planetscale.")) {
    const key = typeof attr.database === "string" ? "database" : "name";
    if (attr[key] !== stageDatabase)
      return refuse(`${kind} lives outside this stage's own database`, key, attr[key]);
    return undefined;
  }
  if (!type.startsWith("Cloudflare.")) return refuse(`${kind} is of a kind this path cannot prove`);
  const strings = Object.entries(attr).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
  );
  const recorded = strings.find(
    ([key, named]) => (isIdKey(key) || isNameKey(key)) && production.has(named),
  );
  if (recorded)
    return refuse(`${kind} records an id or name production's State records`, ...recorded);
  // Keys a Workflow row proves by its host Worker rather than by its own name.
  const hosted = new Set<string>();
  if (type === WORKFLOW) {
    const props = record(value.props) ? value.props : undefined;
    const explicit = typeof props?.workflowName === "string";
    const scriptName = typeof attr.scriptName === "string" ? attr.scriptName : "";
    const host = scriptName
      ? rows.filter(
          (row) =>
            !isStackOutput(row.path) &&
            row.path.split("/")[1] === stage &&
            record(row.value) &&
            row.value.resourceType === "Cloudflare.Worker" &&
            record(row.value.attr) &&
            row.value.attr.workerName === scriptName,
        )
      : [];
    let hostProves = host.length > 0;
    for (const row of host) if (hostProves && (await rowRefusal(row, context))) hostProves = false;
    if (hostProves) hosted.add("scriptName");
    if (!explicit) {
      if (!hostProves)
        return refuse(
          `${kind} is hosted by no Worker this stage proves (scriptName)`,
          "scriptName",
          attr.scriptName,
        );
      const className = typeof attr.className === "string" ? attr.className : "";
      const derived =
        className && (props?.className === undefined || props.className === className)
          ? await workflowName(scriptName, className, namers)
          : undefined;
      if (derived === undefined || attr.workflowName !== derived)
        return refuse(
          `${kind} is not named as Alchemy names it from its host and class (workflowName)`,
          "workflowName",
          attr.workflowName,
        );
      hosted.add("workflowName");
    }
  }
  let derived: string[] | undefined;
  for (const [key, named] of strings) {
    if (!isNameKey(key) || hosted.has(key)) continue;
    const foreign = refuse(`${kind} names an object that is not this stage's (${key})`, key, named);
    if (anyStage.test(named)) {
      if (!token.test(named)) return foreign;
      continue;
    }
    if (ownHost(named)) continue;
    const id = typeof value.logicalId === "string" ? value.logicalId : "";
    const instanceId = typeof value.instanceId === "string" ? value.instanceId : "";
    derived ??= id && instanceId ? await derivedNames(id, instanceId, stage, type, namers) : [];
    if (!derived.includes(named)) return foreign;
  }
  if (Array.isArray(attr.routes))
    for (const route of attr.routes) {
      const pattern = record(route) && typeof route.pattern === "string" ? route.pattern : "";
      const host = pattern.split("/")[0]!.replace(/^\*\.?/u, "");
      const id = record(route) && typeof route.id === "string" ? route.id : "";
      const line = `${kind} routes traffic that is not this stage's (routes)`;
      if (!ownHost(host)) return refuse(line, "routes", pattern);
      if (id && production.has(id)) return refuse(line, "routes", id);
    }
  return undefined;
}

/** Runs one phase and records its elapsed milliseconds under `name`, failed or not. */
export async function timed<A>(
  phases: Record<string, number>,
  name: string,
  work: () => Promise<A>,
): Promise<A> {
  const at = performance.now();
  try {
    return await work();
  } finally {
    phases[name] = Math.round(performance.now() - at);
  }
}

type ProductionRecords = {
  readonly databases: readonly { readonly id?: string; readonly name?: string }[];
  readonly identities: ReadonlySet<string>;
};
type StageStacks = Readonly<Record<string, readonly PreviewStateEntry[]>>;

/** One refused stage, by ordinal and name, with the row that refused it. Private output only. */
export type RetireRefusal = { ordinal: number; stage: string; line: string } & RefusalDetail;

/**
 * The retire's proof over numbered stages, by ordinal: each stage's own stacks are read, then
 * proven against production's records, read once. Without `take` it only reads and proves, for
 * every stage, deletes nothing, and lists every row of a stage that refuses: one public line per
 * stage with their count and kinds. With it, a stage stops at its first refusal, and the first
 * stage that proves is handed to `take` and the run stops there. Public lines name the ordinal and
 * kinds only; every refusal's detail comes back for private output.
 */
export async function proveStages(
  stages: readonly {
    readonly ordinal: number;
    readonly stage: string;
    readonly unreadable?: unknown;
  }[],
  io: {
    target(stage: string): { stage: string; database: string; read(): Promise<StageStacks> };
    production(): Promise<ProductionRecords>;
    /** Each refusal is pushed here as it is found, so a later failure keeps those before it. */
    refusals: RetireRefusal[];
    phases: Record<string, number>;
    log(line: string): void;
    take?(stage: string, stacks: StageStacks): Promise<void>;
  },
) {
  let production: ProductionRecords | undefined;
  for (const { ordinal, stage, unreadable } of stages) {
    if (unreadable) {
      io.log(`  stage ${ordinal} left: its State could not be read`);
      continue;
    }
    const target = io.target(stage);
    const stacks = await timed(io.phases, `stage ${ordinal} read`, () => target.read());
    production ??= await timed(io.phases, "production records", () => io.production());
    const known = production;
    const refused = await timed(io.phases, `stage ${ordinal} proof`, async () => {
      const rows = Object.values(stacks).flat();
      // A read-only pass lists every refusing row; a retire stops at the first.
      if (!io.take) return stageRefusals(rows, target.stage, target.database, known);
      const first =
        databaseRefusal(rows, target.database, known.databases) ??
        (await ownershipRefusal(rows, target.stage, target.database, known.identities));
      return first ? [first] : [];
    });
    if (refused.length > 0) {
      for (const { line, detail } of refused) io.refusals.push({ ordinal, stage, line, ...detail });
      // A stage the proof refuses is left as it is, and the next one is tried.
      if (io.take) io.log(`  stage ${ordinal} left: ${refused[0]!.line}; nothing of it deleted`);
      else {
        const kinds = [...new Set(refused.map(({ detail }) => detail.type ?? "no type"))];
        const count = `${refused.length} ${refused.length === 1 ? "row" : "rows"}`;
        io.log(`  stage ${ordinal} left: ${count} refused (${kinds.join(", ")})`);
      }
      continue;
    }
    if (!io.take) {
      io.log(`  stage ${ordinal}: retirable`);
      continue;
    }
    io.log(`Retiring stage ${ordinal}.`);
    await io.take(stage, stacks);
    return { taken: ordinal };
  }
  return { taken: undefined };
}

/**
 * The leftovers mode's pass of the retire proof, which only reads and never decides the mode: any
 * failure leaves `"unreadable"` and one public line, its text goes to `keepPrivate` only, and the
 * refusals found before it are written either way.
 */
export async function leftoversProof(
  stages: Parameters<typeof proveStages>[0],
  io: Omit<Parameters<typeof proveStages>[1], "refusals" | "take"> & {
    writeRefusals(refusals: readonly RetireRefusal[]): Promise<void>;
    keepPrivate(text: string): Promise<void>;
  },
): Promise<string[] | "unreadable"> {
  const proof: string[] = [];
  const refusals: RetireRefusal[] = [];
  let failure: unknown;
  try {
    await proveStages(stages, {
      target: io.target,
      production: io.production,
      phases: io.phases,
      refusals,
      log: (line) => {
        io.log(line);
        proof.push(line);
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await io.writeRefusals(refusals);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure === undefined) return proof;
  await io
    .keepPrivate(failure instanceof Error ? (failure.stack ?? failure.message) : String(failure))
    .catch(() => undefined);
  io.log("The retire proof could not be read; the table above stands");
  return "unreadable";
}
