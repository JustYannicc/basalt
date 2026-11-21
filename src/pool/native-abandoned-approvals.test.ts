import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, owner, pool, signingKey } from "./test/computers.ts";
import type { StoredComputer } from "./computer-registry.ts";
import { nativeControlPath, nativeControlPrefix } from "./native-contract.ts";
import { signEnvelope } from "./token.ts";

const minute = 60_000;
type Fixture = ReturnType<typeof fixture>;

/** The row an approval wrote before its model key, as releases before #1580 left it when minting failed. */
async function leftIssuing(f: Fixture, id: string, extra: Partial<StoredComputer> = {}) {
  const at = new Date(f.now()).toISOString();
  const row: StoredComputer = {
    id,
    name: "Retried approval",
    user: owner,
    pool: pool.pool,
    state: "issuing",
    createdAt: at,
    boundAt: at,
    firstModelRequestAt: null,
    firstToolCallAt: null,
    revokedAt: null,
    native: { grant: `native:${id}`, models: true, toolsOrganization: pool.organization },
    ...extra,
  };
  await f.storage.put("computer-registry-v1", { ...(await f.registry()), [id]: row });
}

async function approve(f: Fixture, grant: string) {
  const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
    action: "register",
    user: owner,
    grant,
    intent: await f.intent(owner),
    name: "Approved device",
    tools: true,
    models: true,
    expiresAt: f.now() + 10_000,
  });
  const response = await f.nativeControl(
    new Request(`https://pool.example${nativeControlPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { computer: { id: string } }).computer.id;
}

test("upkeep removes issuing rows that failed approvals left without a key", async () => {
  const f = fixture();
  await leftIssuing(f, "first-try");
  await leftIssuing(f, "retry");
  f.advance(2 * 60 * minute);
  await f.expire();
  assert.deepEqual(Object.keys(await f.registry()), []);
});

test("an issuing row of an approval still in progress stays through upkeep", async () => {
  const f = fixture();
  await leftIssuing(f, "approving");
  // A device request can be approved for ten minutes after it starts.
  f.advance(10 * minute);
  await f.expire();
  assert.equal((await f.registry()).approving?.state, "issuing");
});

test("upkeep keeps active devices, issuing rows that hold a key, and web setups", async () => {
  const f = fixture();
  // Approved while the container was stopped: active with no model key yet.
  f.server.stopped = true;
  const keyless = await approve(f, "native:approved-before-key");
  f.server.stopped = false;
  await leftIssuing(f, "minted", { keyId: 71, userId: 1 });
  await leftIssuing(f, "web-setup", { native: undefined });
  f.advance(2 * 60 * minute);
  await f.expire();
  const registry = await f.registry();
  assert.equal(registry[keyless]?.state, "active");
  assert.equal(registry[keyless]?.native?.key, undefined);
  assert.equal(registry.minted?.state, "issuing");
  assert.equal(registry["web-setup"]?.state, "issuing");
  assert.deepEqual(f.removals, []);
});

test("upkeep records how many abandoned approvals it removed, and nothing when none", async () => {
  const f = fixture();
  for (const id of ["one", "two", "three"]) await leftIssuing(f, id);
  f.advance(2 * 60 * minute);
  await leftIssuing(f, "recent");
  await f.expire();
  assert.deepEqual(Object.keys(await f.registry()), ["recent"]);
  assert.deepEqual(f.removals, [{ abandonedApprovals: 3 }]);
  await f.expire();
  assert.deepEqual(f.removals, [{ abandonedApprovals: 3 }]);
});
