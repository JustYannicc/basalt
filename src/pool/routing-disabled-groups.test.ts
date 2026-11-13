import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient, poolGroupPrefix } from "./control.ts";
import { PoolUsage } from "./pool-usage.ts";
import { publishRoutingDemand } from "./routing-demand.ts";
import { readRoutingDecisions } from "./routing-decisions.ts";
import type { CapacityDemandData } from "./capacity/history.ts";

const now = new Date("2026-11-13T12:00:00Z");
const empty: CapacityDemandData = {
  trackingSince: null,
  readAt: null,
  completedWeeks: 0,
  points: [],
  latestReadings: [],
  accountStates: [],
  unclassifiedProviders: [],
  accountDemandTotals: {},
  rollingUse: {},
  rollingComplete: {},
  refills: [],
};

function fixture(allDisabled = false) {
  const writes: { groups: number[]; inputs: unknown[] }[] = [];
  const quotaReads: string[] = [];
  const groups = [
    { id: 1, channel_name: `${poolGroupPrefix}pool`, disabled: true },
    { id: 3, channel_name: `${poolGroupPrefix}pool`, disabled: allDisabled },
  ];
  const page = { decisions: [], current: [{ provider: "claude" }], capacity: [] };
  const client = new HomeClient(async (path, init) => {
    const url = new URL(path, "https://home.example.test");
    const route = url.pathname.slice("/v8/management".length);
    if (route === "/channel-groups") return Response.json({ channel_groups: groups });
    if (route === "/channel-group-details")
      return Response.json({
        channel_group_details: [
          { id: 1, channel_group_id: 1, auth_id: "disabled-only" },
          { id: 2, channel_group_id: 3, auth_id: "active" },
        ],
      });
    if (route === "/capabilities") return Response.json({ capabilities: {} });
    if (route === "/usage/records") return Response.json({ items: [], total: 0 });
    if (route === "/credentials")
      return Response.json({
        files: ["active", "disabled-only"].map((id) => ({ id, provider: "claude" })),
      });
    if (route.startsWith("/quota/credentials/")) {
      const id = route.slice("/quota/credentials/".length);
      quotaReads.push(id);
      return Response.json({ credential: { credential_id: id }, windows: [] });
    }
    if (/^\/channel-groups\/\d+$/.test(route))
      return Response.json({ channel_group: { updated_at: now.toISOString() } });
    if (route.endsWith("/routing-demand")) {
      const body = JSON.parse(String(init?.body));
      if (body.groups.some((id: number) => groups.find((group) => group.id === id)?.disabled))
        return Response.json({ error: "disabled scope" }, { status: 400 });
      writes.push(body);
      return Response.json({ success: true });
    }
    if (route.endsWith("/routing-decisions")) {
      const ids = url.searchParams.get("groups")!.split(",").map(Number);
      if (ids.some((id) => groups.find((group) => group.id === id)?.disabled))
        return Response.json({ error: "disabled scope" }, { status: 400 });
      return Response.json(page);
    }
    throw new Error(`Unexpected Home path ${route}`);
  });
  return { client, writes, quotaReads, page };
}

test("disabled duplicates do not block publication or current routing inspection", async () => {
  const f = fixture();
  await publishRoutingDemand(f.client, "pool", empty, now.getTime(), ["active"]);
  assert.deepEqual(
    f.writes.map((write) => write.groups),
    [[3]],
  );
  assert.deepEqual(await readRoutingDecisions(f.client, "pool"), {
    pages: [f.page],
    changedAt: now.toISOString(),
  });
});

test("capacity sampling excludes distinct members of disabled duplicate groups", async () => {
  const f = fixture();
  const values = new Map<string, unknown>();
  await new PoolUsage({
    client: f.client,
    storage: {
      async get<T>(key: string) {
        return structuredClone(values.get(key)) as T | undefined;
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
      async delete(key) {
        values.delete(key);
      },
    },
    signingKey: "ab".repeat(32),
    audience: async () => [],
    now: () => now,
  }).observe();
  assert.deepEqual(f.quotaReads, ["active"]);
  assert.deepEqual(
    f.writes.map((write) => write.groups),
    [[3]],
  );
});

test("a wholly disabled pool neither publishes nor invents current routing evidence", async () => {
  const f = fixture(true);
  await publishRoutingDemand(f.client, "pool", empty, now.getTime(), []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await readRoutingDecisions(f.client, "pool"), {
    pages: [],
    changedAt: new Date(0).toISOString(),
  });
});
