import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageAccountLabels } from "./usage-account-labels.ts";
import { handleUsageAccountLabel, usageAccountLabelPath } from "./usage-account-label-http.ts";
import { signEnvelope, signPoolToken } from "./token.ts";

test("import labels survive a new reader, stay pool-scoped, and can be changed and removed", async () => {
  const saved = new Map<string, unknown>();
  const transaction = {
    async get<T>(key: string) {
      return structuredClone(saved.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      saved.set(key, structuredClone(value));
    },
  };
  const storage = {
    ...transaction,
    async transaction<T>(work: (tx: typeof transaction) => Promise<T>): Promise<T> {
      return work(transaction);
    },
  };
  const labels = new UsageAccountLabels(storage);
  const account = `imported:${"a".repeat(64)}`;
  await labels.set("pool-a", { account, label: "Old subscription" });
  assert.deepEqual(await new UsageAccountLabels(storage).read("pool-a"), {
    [account]: "Old subscription",
  });
  assert.deepEqual(await labels.read("pool-b"), {});
  await labels.set("pool-a", { account, label: "Renamed" });
  assert.deepEqual(await labels.read("pool-a"), { [account]: "Renamed" });
  await labels.set("pool-a", { account, label: null });
  assert.deepEqual(await labels.read("pool-a"), {});
  for (const input of [
    { account: "saved-native", label: "No" },
    { account, label: " " },
    { account, label: "x".repeat(81) },
  ])
    await assert.rejects(labels.set("pool-a", input));
  const key = [...saved.keys()][0]!;
  const bounded = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      `imported:${i.toString(16).padStart(64, "0")}`,
      "Saved label",
    ]),
  );
  saved.set(key, bounded);
  await assert.rejects(labels.set("pool-a", { account, label: "Exceeds the bound" }));
  assert.deepEqual(await labels.read("pool-a"), bounded);
  await labels.set("pool-a", { account: Object.keys(bounded)[0], label: null });
  await labels.set("pool-a", { account, label: "Fits after removal" });
  assert.equal(Object.keys(await labels.read("pool-a")).length, 500);
});

test("label writes require a current action-bound manager assertion and never an ordinary pool token", async () => {
  const key = "ab".repeat(32);
  const writes: unknown[] = [];
  const access = {
    signingKey: key,
    set: async (pool: string, input: unknown) => {
      writes.push({ pool, input });
      return { success: true as const };
    },
  };
  const payload = {
    action: "setUsageAccountLabel",
    pool: "pool-a",
    user: "manager",
    organization: "org-a",
    canManage: true,
    expiresAt: Date.now() + 25_000,
    input: { account: `imported:${"b".repeat(64)}`, label: "Archive" },
  };
  const request = async (change: Record<string, unknown> = {}) =>
    new Request(`https://pool.example.test${usageAccountLabelPath}`, {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(key, "sbs1", { ...payload, ...change }),
      }),
    });
  for (const change of [
    { canManage: false },
    { action: "poolUsageSeries" },
    { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + 60_000 },
    { user: "" },
  ])
    assert.equal((await handleUsageAccountLabel(await request(change), access)).status, 401);
  const ordinary = new Request(`https://pool.example.test${usageAccountLabelPath}`, {
    method: "POST",
    body: JSON.stringify({
      envelope: await signPoolToken(key, {
        pool: "pool-a",
        owner: "manager",
        organization: "org-a",
      }),
    }),
  });
  assert.equal((await handleUsageAccountLabel(ordinary, access)).status, 401);
  assert.equal(writes.length, 0);
  assert.equal((await handleUsageAccountLabel(await request(), access)).status, 200);
  assert.deepEqual(writes, [{ pool: "pool-a", input: payload.input }]);
});
