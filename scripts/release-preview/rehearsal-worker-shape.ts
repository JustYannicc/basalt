import { readFile, writeFile } from "node:fs/promises";
import { getDurableObjectTagMap } from "alchemy/Cloudflare/Workers";

/**
 * Production's PoolWorker was created by a plain alchemy deploy, untagged. A rehearsal of the
 * single-writer class path only means something from that exact shape, so it is read back and
 * checked before the release, after it, and after each later plain deploy.
 */
export type WorkerShape = {
  tags: readonly string[];
  version: { resources?: { script_runtime?: Record<string, unknown>; bindings?: readonly Binding[] } } & Record<string, unknown>;
  namespaces: readonly { id: string; class: string; script?: string | null; use_sqlite?: boolean }[];
};
type Binding = { type?: string; name?: string; class_name?: string; script_name?: string | null };
export type ShapePhase = "baseline" | "classes";
export type ShapeRecord = { phase: ShapePhase; classes: Record<string, string>; containerNamespace: string };

const fleetClasses = ["PoolRuntimeBlue", "PoolRuntimeGreen"];

export function checkWorkerShape(
  shape: WorkerShape,
  worker: string,
  phase: ShapePhase,
  baseline?: ShapeRecord,
): ShapeRecord {
  const refuse = (reason: string): never => {
    throw new Error(`PoolWorker shape refused (${phase}): ${reason}`);
  };
  const identity = shape.tags.filter((tag) => /^alchemy:(?:stack|stage|id):/u.test(tag));
  const dos = shape.tags.filter((tag) => tag.startsWith("alchemy:dos:"));
  if (identity.length !== 3 || dos.length !== 1) refuse("tags are not the three identity tags plus alchemy:dos");
  if (shape.tags.length !== 4) refuse("unexpected extra tags");
  if (shape.tags.some((tag) => tag.startsWith("alchemy:migration-tag:"))) refuse("a migration tag is present");
  if (shape.version.resources?.script_runtime && "migration_tag" in shape.version.resources.script_runtime)
    refuse("the version records a migration tag");
  if ("exports" in shape.version || (shape.version.resources && "exports" in shape.version.resources))
    refuse("the version read-back carries exports");
  const durable = (shape.version.resources?.bindings ?? []).filter((binding) => binding.type === "durable_object_namespace");
  const local = durable.filter((binding) => !binding.script_name);
  if (!local.some((binding) => binding.class_name === "PoolContainer")) refuse("PoolContainer is not a local binding");
  if (durable.filter((binding) => binding.script_name).length !== 1) refuse("not exactly one cross-script binding");
  const mine = shape.namespaces.filter((namespace) => namespace.script === worker);
  const container = mine.find((namespace) => namespace.class === "PoolContainer");
  if (!container) refuse("the PoolContainer namespace is missing");
  const tagged = Object.values(getDurableObjectTagMap(shape.tags as string[]));
  const classes = Object.fromEntries(
    mine.filter((namespace) => fleetClasses.includes(namespace.class)).map((namespace) => [namespace.class, namespace.id]),
  );
  if (phase === "baseline") {
    if (Object.keys(classes).length) refuse("fleet classes exist before the release");
    if (fleetClasses.some((name) => tagged.includes(name))) refuse("alchemy:dos already names fleet classes");
  } else {
    for (const name of fleetClasses) {
      const namespace = mine.find((candidate) => candidate.class === name);
      if (!namespace || namespace.use_sqlite !== true) refuse(`${name} is not a SQLite namespace on PoolWorker`);
      if (!tagged.includes(name)) refuse(`alchemy:dos does not name ${name}`);
    }
    if (!tagged.includes("PoolContainer")) refuse("alchemy:dos no longer names PoolContainer");
    if (baseline && baseline.containerNamespace !== container!.id) refuse("the PoolContainer namespace changed");
    if (baseline?.phase === "classes" && JSON.stringify(baseline.classes) !== JSON.stringify(classes))
      refuse("a later deploy changed the fleet class namespaces");
  }
  return { phase, classes, containerNamespace: container!.id };
}

/** Reads the shape with the stage's own Cloudflare token; every call is a GET. */
export async function readWorkerShape(accountId: string, worker: string, token: string, fetcher = fetch): Promise<WorkerShape> {
  const api = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
  const get = async (path: string) => {
    const response = await fetcher(`${api}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { success?: boolean; result?: unknown };
    if (!response.ok || body.success !== true) throw new Error(`Cloudflare read failed with HTTP ${response.status}`);
    return body.result;
  };
  const script = `/workers/scripts/${encodeURIComponent(worker)}`;
  const settings = (await get(`${script}/settings`)) as { tags?: string[] };
  const versions = (await get(`${script}/versions?per_page=1`)) as { items?: { id: string }[] };
  const latest = versions.items?.[0]?.id;
  if (!latest) throw new Error("PoolWorker has no version");
  const version = (await get(`${script}/versions/${encodeURIComponent(latest)}`)) as WorkerShape["version"];
  const namespaces = (await get(`/workers/durable_objects/namespaces?per_page=1000`)) as WorkerShape["namespaces"];
  return { tags: settings.tags ?? [], version, namespaces };
}

if (import.meta.main) {
  const [phase, recordPath] = process.argv.slice(2);
  if ((phase !== "baseline" && phase !== "classes") || !recordPath) throw new Error("Usage: rehearsal-worker-shape.ts baseline|classes RECORD");
  const { readReleaseTarget } = await import("../pool-crash-dispatch-sources.ts");
  const target = await readReleaseTarget(process.env);
  const shape = await readWorkerShape(target.accountId, target.worker, process.env.CLOUDFLARE_API_TOKEN ?? "");
  const previous = await readFile(recordPath, "utf8").then((text) => JSON.parse(text) as ShapeRecord, () => undefined);
  const record = checkWorkerShape(shape, target.worker, phase, previous);
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  console.log(`PoolWorker shape ${phase} matches production's single-writer expectations`);
}
