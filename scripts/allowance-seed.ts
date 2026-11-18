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

/**
 * Re-runs the production refresh against current sources. A committed row that expires within
 * the lead is overdue when a source now carries a later expiry for it, and stale when none does.
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
  const entries = (await registry.read()).entries
    .filter((entry) => entry.verification !== "unknown")
    .map((entry) => {
      const { contradicted, ...rest } = entry;
      return contradicted === undefined ? entry : rest;
    });
  const latest = (rows: readonly PlanAllowance[]) => {
    const found = new Map<string, PlanAllowance>();
    for (const entry of rows) {
      const known = found.get(allowanceKey(entry));
      if (!known || (entry.expiresAt ?? 0) > (known.expiresAt ?? 0))
        found.set(allowanceKey(entry), entry);
    }
    return found;
  };
  const renewed = latest(entries);
  const overdue: ExpiringRow[] = [];
  const stale: ExpiringRow[] = [];
  // A plan is at risk when its last-expiring seed row is inside the lead; older rows it
  // supersedes are not.
  for (const [key, entry] of latest(seed.entries)) {
    if (entry.expiresAt === null || entry.expiresAt - options.now > renewalLead) continue;
    const next = renewed.get(key)?.expiresAt ?? null;
    const row = { key: label(entry), expiresAt: entry.expiresAt, renewedExpiresAt: next };
    (next !== null && next > entry.expiresAt ? overdue : stale).push(row);
  }
  const attribution =
    typeof seed.attribution === "string"
      ? seed.attribution.replace(/checked \d{4}-\d{2}-\d{2}/u, `checked ${day(options.now)}`)
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
  if (args.includes("--check") && result.overdue.length) process.exitCode = 1;
}
