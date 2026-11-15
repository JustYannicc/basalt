import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { datasetAllowances } from "./dataset.ts";
import { PlanAllowances } from "./registry.ts";
import {
  planAllowance,
  planAllowanceWindows,
  vendorPlan,
} from "../../../.upstream/packages/apps/src/contracts/account-plan-allowance.ts";
import { accountPlanName } from "../../../.upstream/packages/apps/src/contracts/account-plan-name.ts";

const now = Date.parse("2026-11-13T12:00:00Z");
const fixture = readFileSync(new URL("./fixtures/plan-yield.json", import.meta.url), "utf8");

test("the maintained source's actual schema reaches shared plan sizing and window support", async () => {
  const values = new Map<string, unknown>();
  const registry = new PlanAllowances(
    {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
    },
    {
      now: () => now,
      seed: { entries: [] },
      fetch: async (input) =>
        String(input).includes("planyield")
          ? new Response(fixture)
          : new Response(null, { status: 503 }),
    },
  );
  await registry.refresh();
  const catalog = await registry.read();
  const value = planAllowance(catalog, "codex", "promax", 604_800, now);
  assert.equal(value.full, 50);
  assert.equal(value.verification, "reported");
  assert.equal(value.checkedAt, Date.parse("2026-11-09T00:00:00Z"));
  assert.deepEqual(planAllowanceWindows(catalog, "codex", "promax", [], now), [604_800]);
  assert.deepEqual(
    planAllowanceWindows(catalog, "codex", "promax", [18_000], now),
    [18_000, 604_800],
  );
  assert.equal(
    planAllowance(catalog, "claude", "Max 5x", 604_800, now).known,
    false,
    "a stale dataset row cannot renew itself",
  );
  assert.equal(
    planAllowance(catalog, "claude", "Team", 604_800, now).known,
    false,
    "a floor is not a verified allowance",
  );
});

test("capacity and host names resolve the same raw vendor identity without conflating legacy Grok", () => {
  for (const [raw, id, name] of [
    ["prolite", "prolite", "Pro"],
    ["pro", "pro", "Pro (More)"],
    ["promax", "promax", "Pro (Max)"],
  ] as const) {
    assert.equal(vendorPlan("codex", raw).id, id);
    assert.equal(accountPlanName(raw, "openai"), name);
  }
  assert.equal(accountPlanName("Pro"), "Pro");
  assert.equal(vendorPlan("xai", "GrokPro").id, "grok_pro");
  assert.notEqual(vendorPlan("xai", "GrokPro").id, vendorPlan("xai", "SuperGrok Pro").id);
  assert.equal(vendorPlan("claude", "Max").recognized, false);
});

test("actual vendor source shapes refresh dated facts and unchanged values keep their revision", async () => {
  const bodies: Record<string, string> = JSON.parse(
    readFileSync(new URL("./fixtures/vendor-sources.json", import.meta.url), "utf8"),
  );
  let clock = now;
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
    {
      now: () => clock,
      seed: { entries: [] },
      fetch: async (input) => {
        const url = String(input);
        const key = url.includes("subscription.rs")
          ? "openai-client"
          : url.includes("fxtwitter")
            ? "openai-statement"
            : url.includes("max-plan")
              ? "claude-max"
              : url.includes("ultra-plan")
                ? "claude-ultra"
                : url.includes("x-subscription")
                  ? "x-subscription"
                  : null;
        return key ? new Response(bodies[key]) : new Response(null, { status: 503 });
      },
    },
  );
  await registry.refresh();
  const catalog = await registry.read();
  assert.equal(planAllowance(catalog, "claude", "Max 5x", 604_800, clock).full, 5);
  assert.equal(planAllowance(catalog, "claude", "Ultra", 604_800, clock).full, 10);
  assert.equal(planAllowance(catalog, "codex", "promax", 604_800, clock).full, 50);
  assert.equal(planAllowance(catalog, "xai", "X Subscription Super", 604_800, clock).full, 15);
  assert.equal(planAllowance(catalog, "xai", "Grok Pro", 604_800, clock).full, 1);
  assert.notEqual(
    planAllowance(catalog, "xai", "Grok Pro", 604_800, clock).unit.id,
    planAllowance(catalog, "xai", "X Subscription Super", 604_800, clock).unit.id,
  );
  const previous = planAllowance(catalog, "claude", "Max 5x", 604_800, clock);
  clock += 86_400_000;
  await registry.refresh();
  const updated = planAllowance(await registry.read(), "claude", "Max 5x", 604_800, clock);
  assert.equal(updated.revision, previous.revision);
  assert.equal(updated.checkedAt, clock);
});

test("a current no-limit fact suppresses older caps while temporary reported windows remain", () => {
  const base = {
    vendor: "openai",
    plan: "promax",
    windowSeconds: 18_000,
    unit: { id: "fixture", label: "fixture" },
    revision: "fixture",
    checkedAt: now,
    fetchedAt: now,
    expiresAt: now + 86_400_000,
    sources: ["https://example.test/limits"],
  };
  const catalog: import("./data.ts").PlanAllowanceCatalog = {
    entries: [
      { ...base, full: null, unlimited: true, kind: "dataset", verification: "reported" },
      { ...base, full: 9, kind: "vendor", verification: "verified" },
    ],
  };
  assert.equal(planAllowance(catalog, "codex", "promax", 18_000, now).known, false);
  assert.deepEqual(planAllowanceWindows(catalog, "codex", "promax", [], now), []);
  assert.deepEqual(planAllowanceWindows(catalog, "codex", "promax", [18_000], now), [18_000]);
});

test("a freshly maintained specific Max row resolves its generic display label", async () => {
  const dataset = JSON.parse(fixture);
  for (const row of dataset.options)
    if (row.id === "claude-max-5x") {
      row.status_class = "ok";
      row.checked = "2026-11-13";
    }
  const entries = datasetAllowances(dataset, now);
  const value = planAllowance({ entries }, "claude", "max_5x", 604_800, now);
  assert.equal(value.full, 5);
  assert.equal(value.kind, "dataset");
});
