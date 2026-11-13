import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanAllowances } from "./registry.ts";
import { capacityWeight } from "../capacity/weights.ts";

class Memory {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
}
const now = Date.parse("2026-11-13T12:00:00Z");
const row = (multiple: number) => ({
  id: "codex-chatgpt-pro-500",
  tool: "codex",
  label: "ChatGPT Pro 500",
  multiple: {
    x: multiple,
    base: "ChatGPT Plus",
    basis: "reported",
    floor: "",
    source: "Dated vendor staff statement",
  },
  windows: [
    ["5-hour", "None"],
    ["Weekly", "Yes"],
  ],
  weekly: "yes",
  mechanics: "Weekly",
  checked: "2026-11-12",
  status_class: "warn",
  source: "https://example.test/vendor-source",
});

test("scheduled refresh uses the maintained value and preserves its source check date", async () => {
  let clock = now,
    multiple = 37,
    requests = 0;
  const fetcher = async (input: RequestInfo | URL) => {
    requests++;
    return String(input).includes("planyield")
      ? Response.json({ as_of: "2026-11-13", license: "CC BY 4.0", options: [row(multiple)] })
      : new Response(null, { status: 503 });
  };
  const registry = new PlanAllowances(new Memory(), {
    fetch: fetcher,
    now: () => clock,
    seed: { entries: [] },
  });
  await registry.refresh();
  const first = capacityWeight("codex", "promax", 604_800, {
    catalog: await registry.read(),
    now: clock,
  });
  assert.equal(first.multiplier, 37);
  assert.equal(first.allowance?.checkedAt, Date.parse("2026-11-12T00:00:00Z"));
  const calls = requests;
  await registry.refresh();
  assert.equal(requests, calls, "one claimed refresh per cadence");
  clock += 86_400_000;
  multiple = 43;
  await registry.refresh();
  assert.equal(
    capacityWeight("codex", "promax", 604_800, { catalog: await registry.read(), now: clock })
      .multiplier,
    43,
  );
});

test("a changed source revokes its previous value instead of renewing a seed", async () => {
  let clock = now,
    changed = false;
  const registry = new PlanAllowances(new Memory(), {
    now: () => clock,
    seed: { entries: [] },
    fetch: async (input) =>
      String(input).includes("planyield")
        ? changed
          ? Response.json({ renamed: [] })
          : Response.json({ as_of: "2026-11-13", license: "CC BY 4.0", options: [row(37)] })
        : new Response(null, { status: 503 }),
  });
  await registry.refresh();
  clock += 86_400_000;
  changed = true;
  await registry.refresh();
  const value = capacityWeight("codex", "promax", 604_800, {
    catalog: await registry.read(),
    now: clock,
  });
  assert.equal(value.known, false);
  assert.equal(value.multiplier, 1);
  assert.match(value.unit.id, /promax/);
  assert.equal(value.allowance?.checkedAt, Date.parse("2026-11-12T00:00:00Z"));
});

test("network failure does not renew source age and expiry needs no refresh job", async () => {
  let clock = now,
    failed = false;
  const registry = new PlanAllowances(new Memory(), {
    now: () => clock,
    seed: { entries: [] },
    fetch: async (input) =>
      !failed && String(input).includes("planyield")
        ? Response.json({ as_of: "2026-11-13", license: "CC BY 4.0", options: [row(37)] })
        : new Response(null, { status: 503 }),
  });
  await registry.refresh();
  clock += 86_400_000;
  failed = true;
  await registry.refresh();
  assert.equal(
    capacityWeight("codex", "promax", 604_800, { catalog: await registry.read(), now: clock })
      .multiplier,
    37,
  );
  clock += 14 * 86_400_000;
  const expired = capacityWeight("codex", "promax", 604_800, {
    catalog: await registry.read(),
    now: clock,
  });
  assert.equal(expired.known, false);
  assert.equal(expired.multiplier, 1);
});

test("an expired vendor statement cannot contradict a freshly checked dataset", async () => {
  const bodies: Record<string, string> = JSON.parse(
    readFileSync(new URL("./fixtures/vendor-sources.json", import.meta.url), "utf8"),
  );
  let clock = now;
  const registry = new PlanAllowances(new Memory(), {
    now: () => clock,
    seed: { entries: [] },
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("planyield"))
        return Response.json({
          as_of: new Date(clock).toISOString().slice(0, 10),
          license: "CC BY 4.0",
          options: [{ ...row(50), checked: new Date(clock).toISOString().slice(0, 10) }],
        });
      if (url.includes("subscription.rs")) return new Response(bodies["openai-client"]);
      if (url.includes("fxtwitter")) return new Response(bodies["openai-statement"]);
      return new Response(null, { status: 503 });
    },
  });
  await registry.refresh();
  assert.equal(
    capacityWeight("codex", "promax", 604_800, { catalog: await registry.read(), now: clock })
      .multiplier,
    50,
  );
  clock += 15 * 86_400_000;
  await registry.refresh();
  const value = capacityWeight("codex", "promax", 604_800, {
    catalog: await registry.read(),
    now: clock,
  });
  assert.equal(value.multiplier, 50);
  assert.equal(value.allowance?.kind, "dataset");
});

test("rejected source rows do not contradict fresh fallback before their original expiry", async () => {
  const bodies: Record<string, string> = JSON.parse(
    readFileSync(new URL("./fixtures/vendor-sources.json", import.meta.url), "utf8"),
  );
  for (const change of ["dataset", "vendor", "conflict"]) {
    let clock = now;
    let changed = false;
    const registry = new PlanAllowances(new Memory(), {
      now: () => clock,
      seed: { entries: [] },
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("planyield"))
          return Response.json({
            as_of: "2026-11-13",
            license: "CC BY 4.0",
            options: [
              {
                ...row(changed && change === "conflict" ? 43 : 50),
                ...(changed && change === "dataset" ? { status_class: "stale" } : {}),
              },
            ],
          });
        if (url.includes("subscription.rs")) return new Response(bodies["openai-client"]);
        if (url.includes("fxtwitter"))
          return new Response(changed && change === "vendor" ? "{}" : bodies["openai-statement"]);
        return new Response(null, { status: 503 });
      },
    });
    await registry.refresh();
    clock += 86_400_000;
    changed = true;
    await registry.refresh();
    const value = capacityWeight("codex", "promax", 604_800, {
      catalog: await registry.read(),
      now: clock,
    });
    if (change === "conflict") {
      assert.equal(value.known, false, "actual current disagreement stays unknown");
    } else {
      assert.equal(value.multiplier, 50, change);
      assert.equal(value.allowance?.kind, change === "dataset" ? "vendor" : "dataset");
    }
  }
});
