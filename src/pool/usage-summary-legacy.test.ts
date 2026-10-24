import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName } from "./backend-users.ts";
import { poolGroupPrefix } from "./control.ts";
import { UsageLedger } from "./usage-summary.ts";
import { ChunkStorage, type UsageStorage } from "./usage-storage.ts";
import type { Json } from "./json.ts";

class Memory implements UsageStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { this.values.delete(key); }
}
class Home {
  records: Json[] = [];
  async allMembership() {
    return { groups: ["pool-a", "pool-b"].map((pool, i) => ({ id: i + 1, channel_name: `${poolGroupPrefix}${pool}` })),
      members: ["pool-a", "pool-b"].map((pool, i) => ({ id: i + 1, channel_group_id: i + 1, auth_id: `credential-${pool}` })) };
  }
  async data(path: string): Promise<Json> {
    if (path === "/capabilities") return { capabilities: {} };
    const query = new URL(path, "https://fixture.invalid").searchParams;
    const records = this.records.filter((row) => Date.parse(String(row.timestamp)) >= Date.parse(query.get("from")!)
      && Date.parse(String(row.timestamp)) < Date.parse(query.get("to")!));
    const offset = Number(query.get("offset"));
    return { items: records.slice(offset, offset + 200), total: records.length };
  }
}
async function record(id: string, timestamp: string): Promise<Json> {
  return { id, timestamp, model: "fixture", provider: "fixture", credential: { credential_id: "credential-pool-a" } };
}
const now = new Date("2026-10-24T12:00:00Z");
const options = (caller = "owner") => ({ owner: "owner", caller, members: ["member-a"], days: 30, now, cap: () => null });

test("legacy names attribute by person digest and credential membership; unassigned receipts stay deduped", async () => {
  const storage = new Memory(), home = new Home();
  const legacy = (await backendUserName("member-a", "pool-a")).slice(0, -17);
  const known = await record("legacy-known", "2026-10-24T01:00:00Z");
  const gone = await record("legacy-gone", "2026-10-24T01:00:00Z");
  known.client = { username: legacy }; gone.client = { username: legacy };
  gone.credential = { credential_id: "gone" };
  home.records = [known, gone];
  const ledger = new UsageLedger(storage, home);
  await ledger.sync(now);
  assert.equal((await ledger.summary("pool-a", options("member-a"))).total.requests, 1);
  assert.equal((await ledger.summary("pool-a", options())).members?.find((row) => row.member === "member-a")?.requests, 1);
  const chunks = new ChunkStorage(storage);
  const unassigned = "usage-v1:pool::2026-10-24";
  assert.equal((await chunks.get<{ requests: number; person: string }[]>(unassigned))?.[0]?.requests, 1);
  assert.equal((await chunks.get<{ person: string }[]>(unassigned))?.[0]?.person, "other");
  // Membership returning later must not count this receipt in a pool as well.
  gone.credential = { credential_id: "credential-pool-b" };
  await ledger.sync(now);
  assert.equal((await ledger.summary("pool-b", options())).total.requests, 0);
  assert.equal((await ledger.summary("", options())).total.requests, 0);
  const later = new Date("2026-11-24T12:00:00Z");
  await ledger.sync(later);
  assert.equal(await chunks.get(unassigned), undefined);
  for (let i = 0; i < 31; i++) await ledger.sync(later);
  assert.ok(![...storage.values.keys()].some((key) => key.startsWith("usage-v1:seen:2026-10-24")));
});
