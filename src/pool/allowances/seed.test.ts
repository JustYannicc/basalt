import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PlanAllowances } from "./registry.ts";
import type { PlanAllowanceCatalog } from "./data.ts";
import { planAllowance } from "../../../.upstream/packages/apps/src/contracts/account-plan-allowance.ts";

// These tests own their seed. The bundled seed is renewed every few days, so a test that read it
// would break at each renewal and pass only for the rows that renewal happened to keep.
const seed: PlanAllowanceCatalog = JSON.parse(
  readFileSync(new URL("./fixtures/seed-max20x.json", import.meta.url), "utf8"),
);
const statement = (
  JSON.parse(
    readFileSync(new URL("./fixtures/vendor-sources.json", import.meta.url), "utf8"),
  ) as Record<string, string>
)["claude-ultra"]!;
const without = statement.replace(
  /The Max 20x plan is now called the Ultra plan/u,
  "Ultra replaced an older plan",
);
const day = 86_400_000;

function memory(values = new Map<string, unknown>()) {
  return {
    values,
    async get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
  };
}

const ultraOnly = (body: () => string) => async (input: RequestInfo | URL) =>
  String(input).includes("ultra-plan") ? new Response(body()) : new Response(null, { status: 503 });

test("the Ultra statement refreshes Max 20x policy rows with the seed's revisions and revokes them when it goes", async () => {
  let ultra = without;
  let clock = Date.parse("2026-11-19T12:00:00Z");
  const registry = new PlanAllowances(memory(), {
    now: () => clock,
    seed,
    fetch: ultraOnly(() => ultra),
  });
  // Production already holds a claude-ultra state with only the Ultra row.
  await registry.refresh();
  ultra = statement;
  clock += day;
  await registry.refresh();
  const pastSeed = Date.parse("2026-11-28T12:00:00Z");
  const weekly = planAllowance(await registry.read(), "claude", "Max 20x", 604_800, pastSeed);
  const session = planAllowance(await registry.read(), "claude", "Max 20x", 18_000, pastSeed);
  assert.equal(weekly.full, 20);
  assert.equal(weekly.revision, "2026-11-09-max20x-20");
  assert.equal(weekly.checkedAt, clock);
  assert.equal(session.full, 20);
  assert.equal(session.revision, "2026-10-30");
  ultra = without;
  clock += day;
  await registry.refresh();
  // Revoked while the seed's own policy rows are still current.
  assert.equal(
    planAllowance(await registry.read(), "claude", "Max 20x", 604_800, clock).known,
    false,
  );
});

test("a renewed seed changes no decision for a pool whose source state is stored", async () => {
  // A renewal re-dates the rows of sources the pool refreshes, keeps the pool's own policy rows,
  // and adds the Max 20x rows the Ultra statement now produces. It runs after the pool's last
  // check and before the deploy that ships it.
  const later = (at: number | null) => (at === null ? null : at + 7 * day + 18 * 3_600_000);
  const redated = (entry: PlanAllowanceCatalog["entries"][number]) => ({
    ...entry,
    checkedAt: later(entry.checkedAt),
    fetchedAt: later(entry.fetchedAt),
    expiresAt: later(entry.expiresAt),
  });
  const renewed: PlanAllowanceCatalog = {
    entries: [
      ...seed.entries.map((entry) => (entry.sourceId === "pool-policy" ? entry : redated(entry))),
      ...seed.entries
        .filter((entry) => entry.plan === "max_20x")
        .map((entry) => redated({ ...entry, sourceId: "claude-ultra" })),
    ],
  };
  const start = Date.parse("2026-11-19T12:00:00Z");
  const renewalDay = start + 2 * day;
  const afterSeedExpiry = Date.parse("2026-11-28T12:00:00Z");
  const down = async () => new Response(null, { status: 503 });
  const decisions = async (
    stored: Map<string, unknown>,
    catalog: PlanAllowanceCatalog,
    fetch: typeof globalThis.fetch,
  ) => {
    let clock = renewalDay;
    const registry = new PlanAllowances(memory(new Map(structuredClone([...stored]))), {
      now: () => clock,
      seed: catalog,
      fetch,
    });
    const result = [];
    // The first read is the deploy's, before that day's refresh has run.
    for (const [when, refresh] of [
      [renewalDay, false],
      [renewalDay, true],
      [afterSeedExpiry, false],
    ] as const) {
      clock = when;
      if (refresh) await registry.refresh();
      const read = await registry.read();
      for (const plan of ["Max 20x", "Ultra"])
        for (const window of [18_000, 604_800]) {
          const { known, full, revision, kind, sourceId, checkedAt, expiresAt } = planAllowance(
            read,
            "claude",
            plan,
            window,
            when,
          );
          result.push({
            when,
            plan,
            window,
            known,
            full,
            revision,
            kind,
            sourceId,
            checkedAt,
            expiresAt,
          });
        }
    }
    return result;
  };
  for (const [shape, history] of [
    ["the statement named Max 20x at every check", [statement, statement]],
    ["the statement first named only Ultra", [without, statement]],
  ] as const) {
    let clock = start;
    let body: string = history[0];
    const stored = memory();
    const before = new PlanAllowances(stored, {
      now: () => clock,
      seed,
      fetch: ultraOnly(() => body),
    });
    for (const step of history) {
      body = step;
      await before.refresh();
      clock += day;
    }
    const kept = await decisions(
      stored.values,
      seed,
      ultraOnly(() => statement),
    );
    assert.deepEqual(
      await decisions(
        stored.values,
        renewed,
        ultraOnly(() => statement),
      ),
      kept,
      shape,
    );
    assert.ok(
      kept.some((d) => d.plan === "Max 20x" && d.revision === "2026-11-09-max20x-20" && d.known),
      shape,
    );
    // While the source is down the seed is its fallback: the renewal's newer rows decide, with
    // the same size and revision, and only stay current for longer.
    const undated = (rows: Awaited<ReturnType<typeof decisions>>) =>
      rows.map(({ when, plan, window, known, full, revision, kind, sourceId }) => ({
        when,
        plan,
        window,
        known,
        full,
        revision,
        kind,
        sourceId,
      }));
    const fallback = await decisions(stored.values, renewed, down);
    assert.deepEqual(undated(fallback), undated(await decisions(stored.values, seed, down)), shape);
    assert.ok(
      fallback.some(
        (d) => d.plan === "Max 20x" && d.checkedAt === later(seed.entries[1]!.checkedAt),
      ),
      shape,
    );
  }
  // Without stored state the seed alone decides, so there the renewal does change the answer.
  assert.notDeepEqual(
    await decisions(new Map(), renewed, down),
    await decisions(new Map(), seed, down),
  );
});
