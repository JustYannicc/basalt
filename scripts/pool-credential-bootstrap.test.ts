import assert from "node:assert/strict";
import test from "node:test";
import { fixtureNow, fixturePlan, providerFixture } from "./pool-credential-bootstrap/fixture.ts";
import { secretName, tokenName, type BootstrapPlan } from "./pool-credential-bootstrap/contract.ts";

function recovery(mode: "inspect" | "rotate" | "revoke", tokenId: string | null): BootstrapPlan {
  return { ...fixturePlan(), mode, tokenId };
}

test("the MCP program mints one account-scoped read token and passes its value directly to the existing store", async () => {
  const provider = providerFixture();
  const result = await provider.run();
  assert.deepEqual(result, {
    tokenId: "1".padStart(32, "0"),
    secretName: secretName(fixturePlan().target),
    outcome: "stored",
  });
  assert.equal(provider.minted, 1);
  assert.equal(provider.tokens.length, 1);
  assert.equal(provider.secrets.length, 1);
  assert.equal(provider.values.get(provider.secrets[0]!.id), provider.leaked);
  assert.deepEqual(provider.tokens[0]!.policies, [
    {
      effect: "allow",
      permission_groups: [{ id: "cfd39eebc07c4e3ea849e4b3d2644637" }],
      resources: { ["com.cloudflare.api.account." + fixturePlan().target.accountId]: "*" },
    },
  ]);
  assert.equal(provider.tokens[0]!.name, tokenName(fixturePlan().target));
  assert.ok(!JSON.stringify(result).includes(provider.leaked));
  assert.deepEqual(
    provider.calls.filter((call) => call.method !== "GET").map((call) => call.method),
    ["POST", "POST"],
  );
});

test("a lost create reply cannot cause another mint, even under a new operation", async () => {
  const provider = providerFixture({ loseCreateReply: true });
  const result = await provider.run();
  assert.equal(result.outcome, "unknown_create");
  assert.equal(result.tokenId, null);
  assert.ok(!JSON.stringify(result).includes(provider.leaked));
  assert.equal((await provider.run()).outcome, "refused_existing");
  const changed = {
    ...fixturePlan(),
    target: { ...fixturePlan().target, operationId: "44444444-4444-4444-8444-444444444444" },
  };
  assert.equal((await provider.run(changed)).outcome, "refused_existing");
  assert.equal(provider.minted, 1);
  assert.equal(provider.secrets.length, 0);
  const observed = await provider.run(recovery("inspect", null));
  assert.equal(observed.outcome, "owned_token");
  assert.equal(observed.tokenId, provider.tokens[0]!.id);
});

for (const failure of ["failStore", "loseStoreReply"] as const)
  test(`${failure} retains custody uncertainty and recovery rotates only the owned token`, async () => {
    const options = { [failure]: true };
    const provider = providerFixture(options);
    const result = await provider.run();
    assert.equal(result.outcome, "unknown_store");
    assert.ok(!JSON.stringify(result).includes(provider.leaked));
    const id = provider.tokens[0]!.id;
    const inspected = await provider.run(recovery("inspect", id));
    assert.equal(inspected.outcome, "owned_token");
    options.failStore = false;
    options.loseStoreReply = false;
    assert.equal((await provider.run(recovery("rotate", id))).outcome, "stored");
    assert.equal(provider.values.get(provider.secrets[0]!.id), provider.leaked + "-rotation-1");
    assert.equal(provider.secrets.length, 1);
    assert.equal(provider.minted, 1);
    assert.equal(provider.rotations, 1);
    assert.equal(provider.calls.filter((call) => call.method === "PUT").length, 1);
  });

test("a lost revoke reply settles by exact token absence without another DELETE", async () => {
  const provider = providerFixture({ loseRevokeReply: true });
  const stored = await provider.run();
  const plan = recovery("revoke", stored.tokenId);
  assert.equal((await provider.run(plan)).outcome, "unknown_revoke");
  assert.equal(provider.tokens.length, 0);
  assert.equal((await provider.run(plan)).outcome, "revoked");
  assert.equal(provider.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(provider.secrets.length, 1);
});

for (const failure of ["loseRotateReply", "failPatch"] as const)
  test(`${failure} cannot turn unchanged secret metadata into proof of rotated-value custody`, async () => {
    const provider = providerFixture({ [failure]: true });
    const stored = await provider.run();
    assert.equal(stored.outcome, "stored");
    const rotated = await provider.run(recovery("rotate", stored.tokenId));
    assert.equal(
      rotated.outcome,
      failure === "loseRotateReply" ? "unknown_rotate" : "unknown_store",
    );
    assert.equal(provider.rotations, 1);
    assert.equal(provider.values.get(provider.secrets[0]!.id), provider.leaked);
    assert.equal((await provider.run(recovery("inspect", stored.tokenId))).outcome, "owned_token");
    assert.equal(provider.rotations, 1);
  });

test("target drift, incomplete inventory and provider errors refuse without writes or diagnostic values", async () => {
  for (const options of [{ wrongStore: true }, { unboundedInventory: true }, { throwRead: true }]) {
    const provider = providerFixture(options);
    const result = await provider.run();
    assert.equal(
      result.outcome,
      options.wrongStore
        ? "refused_target"
        : options.unboundedInventory
          ? "refused_inventory"
          : "unknown_read",
    );
    assert.equal(provider.calls.filter((call) => call.method !== "GET").length, 0);
    assert.ok(provider.calls.length <= 12);
    assert.ok(!JSON.stringify(result).includes(provider.leaked));
  }
  const wrongAccount = providerFixture();
  assert.equal((await wrongAccount.run(fixturePlan(), "f".repeat(32))).outcome, "refused_target");
  assert.equal(wrongAccount.calls.length, 0);
});

test("permission drift after mint prevents storage, rotation and revocation", async () => {
  const provider = providerFixture({ wrongPolicy: true });
  const result = await provider.run();
  assert.equal(result.outcome, "refused_ownership");
  assert.equal(provider.secrets.length, 0);
  const id = provider.tokens[0]!.id;
  for (const mode of ["inspect", "rotate", "revoke"] as const)
    assert.equal((await provider.run(recovery(mode, id))).outcome, "refused_ownership");
  assert.equal(provider.rotations, 0);
  assert.equal(provider.tokens.length, 1);
});

test("a foreign secret or supplied token ID cannot be overwritten or deleted", async () => {
  const provider = providerFixture();
  const stored = await provider.run();
  const initialWrites = provider.calls.filter((call) => call.method !== "GET").length;
  assert.equal(
    (await provider.run(recovery("rotate", "f".repeat(32)))).outcome,
    "refused_ownership",
  );
  provider.secrets[0]!.comment = "foreign";
  for (const mode of ["rotate", "revoke"] as const)
    assert.equal((await provider.run(recovery(mode, stored.tokenId))).outcome, "refused_ownership");
  assert.equal((await provider.run()).outcome, "refused_existing");
  assert.equal(provider.calls.filter((call) => call.method !== "GET").length, initialWrites);
});

test("expired execution cannot send requests", async () => {
  const expired = providerFixture();
  expired.now = fixtureNow + 300_000;
  assert.equal((await expired.run()).outcome, "refused_target");
  assert.equal(expired.calls.length, 0);
});
