import { readFileSync, writeFileSync } from "node:fs";
import { allowanceKey, dayMs, type PlanAllowance } from "../src/pool/allowances/data.ts";
import { PlanAllowances } from "../src/pool/allowances/registry.ts";

const seedPath = new URL("../src/pool/allowances/seed.json", import.meta.url);
/** Renewal must land this long before a row expires, so a release can carry it in time. */
export const renewalLead = 7 * dayMs;

interface Seed {
  attribution?: unknown;
  entries: PlanAllowance[];
}
export interface ExpiringRow {
  key: string;
  expiresAt: number;
  renewedExpiresAt: number | null;
}

const label = (entry: Pick<PlanAllowance, "vendor" | "plan" | "windowSeconds">) =>
  `${entry.vendor}/${entry.plan}/${entry.windowSeconds}s`;

const order = (a: PlanAllowance, b: PlanAllowance) =>
  (a.sourceId ?? "").localeCompare(b.sourceId ?? "") ||
  a.vendor.localeCompare(b.vendor) ||
  a.plan.localeCompare(b.plan) ||
  a.windowSeconds - b.windowSeconds ||
  a.kind.localeCompare(b.kind);
const sameValue = (a: PlanAllowance, b: PlanAllowance) =>
  allowanceKey(a) === allowanceKey(b) &&
  a.full === b.full &&
  a.unit.id === b.unit.id &&
  Boolean(a.unlimited) === Boolean(b.unlimited);

/**
 * Re-runs the production refresh against current sources. A source that answered and parsed
 * replaces its seed rows; one that was unavailable or could not be parsed keeps them, so a broken
 * source never empties the fallback. A committed row inside the lead is overdue when its own
 * source now runs later, and stale when nothing with the same value outlives the lead.
 */
export async function renewSeed(
  seed: Seed,
  options: { fetch?: typeof fetch; now: number },
): Promise<{ seed: Seed; overdue: ExpiringRow[]; stale: ExpiringRow[] }> {
  const values = new Map<string, unknown>();
  const registry = new PlanAllowances(
    {
      async get<T>(key: string) {
        return structuredClone(values.get(key)) as T | undefined;
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
    },
    { now: () => options.now, seed, ...(options.fetch ? { fetch: options.fetch } : {}) },
  );
  await registry.refresh();
  const sources = Object.entries((await registry.status())?.sources ?? {}).filter(
    ([, source]) =>
      source.state !== "unavailable" &&
      source.entries.some((entry) => entry.verification !== "unknown"),
  );
  const renewedIds = new Set(sources.map(([id]) => id));
  const refreshed = sources.flatMap(([, source]) =>
    source.entries.filter((entry) => entry.verification !== "unknown"),
  );
  const entries = [
    ...seed.entries.filter((entry) => !entry.sourceId || !renewedIds.has(entry.sourceId)),
    ...refreshed,
  ].toSorted(order);
  const overdue: ExpiringRow[] = [];
  const stale: ExpiringRow[] = [];
  for (const entry of seed.entries) {
    if (entry.expiresAt === null || entry.expiresAt - options.now > renewalLead) continue;
    const own = refreshed.find(
      (value) => value.sourceId === entry.sourceId && allowanceKey(value) === allowanceKey(entry),
    );
    const row = {
      key: `${label(entry)} (${entry.sourceId ?? "seed"})`,
      expiresAt: entry.expiresAt,
      renewedExpiresAt: own?.expiresAt ?? null,
    };
    if (own?.expiresAt != null && own.expiresAt > entry.expiresAt) overdue.push(row);
    else if (
      !entries.some(
        (value) =>
          sameValue(value, entry) &&
          value.expiresAt !== null &&
          value.expiresAt - options.now > renewalLead,
      )
    )
      stale.push(row);
  }
  if (JSON.stringify(entries) === JSON.stringify(seed.entries.toSorted(order)))
    return { seed, overdue, stale };
  const checked = Math.max(...refreshed.map((entry) => entry.checkedAt ?? 0));
  const attribution =
    typeof seed.attribution === "string" && checked > 0
      ? seed.attribution.replace(/checked \d{4}-\d{2}-\d{2}/u, `checked ${day(checked)}`)
      : seed.attribution;
  return { seed: { ...seed, attribution, entries }, overdue, stale };
}

const day = (at: number | null) => (at === null ? "none" : new Date(at).toISOString().slice(0, 10));

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const committed: Seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const result = await renewSeed(committed, { now: Date.now() });
  for (const row of result.stale)
    console.log(
      `::warning::Seed allowance ${row.key} expires ${day(row.expiresAt)} and no source has re-checked it`,
    );
  for (const row of result.overdue)
    console.log(
      `::error::Seed allowance ${row.key} expires ${day(row.expiresAt)}; a source now runs to ${day(row.renewedExpiresAt)}, so the seed renewal is overdue`,
    );
  if (args.includes("--write"))
    writeFileSync(seedPath, `${JSON.stringify(result.seed, null, 2)}\n`);
  const body = option("--body-file");
  if (body)
    writeFileSync(
      body,
      [
        "Renews `src/pool/allowances/seed.json` from the same public sources the pool refreshes daily, so the fallback catalog stays inside its source-dated expiry.",
        "",
        ...(result.stale.length
          ? [
              "Rows whose source has not re-checked them, still expiring within 7 days:",
              ...result.stale.map((row) => `- ${row.key}: expires ${day(row.expiresAt)}`),
            ]
          : ["Every row expiring within 7 days was renewed."]),
      ].join("\n"),
    );
  const verdict = option("--overdue-file");
  if (verdict)
    writeFileSync(
      verdict,
      result.overdue.map((row) => `${row.key} expires ${day(row.expiresAt)}\n`).join(""),
    );
  if (args.includes("--check") && result.overdue.length) process.exitCode = 1;
}
