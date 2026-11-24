// Rows a revoke or an interrupted web setup left behind are finished by the pool's upkeep once
// Home answers, asking Home at most once a minute. Home here is the pool fixture's Home server;
// the clock is the controller's injected one.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Registry, StoredComputer } from "./computer-registry.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
} from "./native-contract.ts";
import { brand } from "../../brand.ts";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import { signEnvelope } from "./token.ts";

type Fixture = ReturnType<typeof fixture>;
/** Upkeep asks Home about a row at most this often, and not at all for this long after Home fails. */
const leftoverRetryMs = 60_000;
/** A web setup takes seconds; an `issuing` row this old with no key and no link was interrupted. */
const interruptedSetupMs = 60 * 60_000;
const registryKey = "computer-registry-v1";
const homeRevokes = (f: Fixture) =>
  f.server.calls.filter((call) => call.method === "DELETE" && call.path === "/access/api-keys")
    .length;
const row = async (f: Fixture, id: string) => (await f.registry())[id];
const holds = (f: Fixture, keyId: number | undefined) =>
  f.server.keys.some((key) => key.api_key_id === keyId);
/** Data an older release left in the registry. */
async function leave(f: Fixture, change: (registry: Registry) => void) {
  const registry = await f.registry();
  change(registry);
  await f.storage.put(registryKey, registry);
}

/** A native device approved through the pool's control endpoint; with models, its key minted. */
async function nativeDevice(f: Fixture, models: boolean, mint = models) {
  const grant = models ? "native:models-device" : "native:tools-device";
  const control = async (action: string, values: Record<string, unknown> = {}) =>
    f.nativeControl(
      new Request(`https://pool.example${nativeControlPath}`, {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(signingKey, nativeControlPrefix, {
            action,
            user: owner,
            grant,
            models,
            expiresAt: f.now() + 10_000,
            ...values,
          }),
        }),
      }),
    );
  const registered = await control("register", {
    intent: await f.intent(owner),
    name: "Native client",
    tools: true,
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  const { computer } = (await registered.json()) as { computer: { id: string } };
  if (mint) {
    const path = "/v1/responses";
    const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
      user: owner,
      grant,
      computer: computer.id,
      pool: pool.pool,
      expiresAt: f.now() + 10_000,
      method: "POST",
      path,
    });
    (
      await f.nativeModel(
        new Request(`https://pool.example${path}`, {
          method: "POST",
          headers: { [nativeModelHeader]: assertion },
          body: JSON.stringify({ model: "synthetic-model", stream: true }),
        }),
      )
    ).release();
    assert.equal(f.server.keys.length, 1, "the device's key was minted at Home");
  }
  const revoke = () => control("revoke", { computer: computer.id, pool: pool.pool });
  return { id: computer.id, revoke };
}

test("a row left in revoking with a key is finished by upkeep once Home answers", async () => {
  const f = fixture();
  const device = await nativeDevice(f, true);
  const { keyId } = (await row(f, device.id))!;
  f.server.revokeFailure = true;
  assert.notEqual((await device.revoke()).status, 200);
  assert.equal((await row(f, device.id))?.state, "revoking");

  const asked = homeRevokes(f);
  await f.expire();
  assert.equal(homeRevokes(f), asked + 1, "upkeep asks Home");
  assert.equal((await row(f, device.id))?.state, "revoking");
  await f.expire();
  f.advance(leftoverRetryMs - 1);
  await f.expire();
  assert.equal(homeRevokes(f), asked + 1, "not again within the minute while Home fails");

  f.server.revokeFailure = false;
  f.advance(1);
  await f.expire();
  assert.equal(homeRevokes(f), asked + 2);
  const finished = await row(f, device.id);
  assert.equal(finished?.state, "revoked");
  assert.equal(finished?.revokedAt, new Date(f.now()).toISOString());
  assert.equal(finished?.native?.key, undefined);
  assert.equal(holds(f, keyId), false, "Home no longer holds the key");

  f.advance(leftoverRetryMs);
  await f.expire();
  assert.equal(homeRevokes(f), asked + 2, "a finished row needs Home no more");
});

test("a keyless row left in revoking is finished by upkeep without revoking anything at Home", async () => {
  const f = fixture();
  // A models device revoked before its first model use: it never had a key.
  const device = await nativeDevice(f, true, false);
  await leave(f, (registry) => {
    registry[device.id]!.state = "revoking";
  });
  f.server.revokeFailure = true;
  const asked = homeRevokes(f);
  await f.expire();
  assert.equal(homeRevokes(f), asked, "a device with no key has nothing to revoke at Home");
  const finished = await row(f, device.id);
  assert.equal(finished?.state, "revoked");
  assert.equal(finished?.revokedAt, new Date(f.now()).toISOString());
});

test("a tools-only native device left in revoking stays revoking: its grant may still work", async () => {
  const f = fixture();
  const device = await nativeDevice(f, false);
  await leave(f, (registry) => {
    registry[device.id]!.state = "revoking";
  });
  const asked = homeRevokes(f);
  await f.expire();
  const left = await row(f, device.id);
  assert.equal(left?.state, "revoking", "only its person's revoke ends its grant");
  assert.equal(left?.revokedAt, null);
  assert.equal(left?.homeKeysRevokedAt, new Date(f.now()).toISOString());
  assert.equal(homeRevokes(f), asked);
  // Its person's revoke still finishes it.
  assert.equal((await device.revoke()).status, 200);
  assert.equal((await row(f, device.id))?.state, "revoked");
});

test("upkeep leaves a row the access-removal queue owns", async () => {
  const f = fixture();
  const device = await nativeDevice(f, true);
  const { keyId } = (await row(f, device.id))!;
  await leave(f, (registry) => {
    registry[device.id]!.state = "revoking";
    registry[device.id]!.removalPending = true;
  });
  const asked = homeRevokes(f);
  await f.expire();
  assert.equal(homeRevokes(f), asked);
  assert.equal((await row(f, device.id))?.state, "revoking");
  assert.equal(holds(f, keyId), true);
});

test("a row that changes while upkeep asks Home is left for the next pass", async () => {
  const f = fixture();
  const device = await nativeDevice(f, true);
  await leave(f, (registry) => {
    registry[device.id]!.state = "revoking";
  });
  let release!: () => void;
  f.server.revokeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asking = new Promise<void>((resolve) => {
    f.server.onRevoke = resolve;
  });
  const upkeep = f.expire();
  // Upkeep that never asks Home finishes instead, and the row must still be untouched.
  await Promise.race([asking, upkeep]);
  // Access removal takes the row over while Home is being asked.
  await leave(f, (registry) => {
    registry[device.id]!.removalPending = true;
  });
  release();
  await upkeep;
  const left = await row(f, device.id);
  assert.equal(left?.state, "revoking");
  assert.equal(left?.removalPending, true);
  assert.equal(left?.revokedAt, null, "upkeep didn't overwrite the row");
});

test("a web setup left in revoking loses its Home key by upkeep, and its tools token waits for its person", async () => {
  const f = fixture();
  const computer = await f.create();
  const id = computer.computer.id;
  const { keyId } = (await row(f, id))!;
  f.server.revokeFailure = true;
  assert.equal((await f.action("revoke", member, computer.intent, { id })).status, 503);
  assert.equal(holds(f, keyId), true);

  f.server.revokeFailure = false;
  await f.expire();
  assert.equal(holds(f, keyId), false, "upkeep revoked the model key");
  const left = await row(f, id);
  assert.equal(left?.state, "revoking", "its tools token may still work");
  assert.equal(left?.homeKeysRevokedAt, new Date(f.now()).toISOString());
  const asked = homeRevokes(f);
  f.advance(leftoverRetryMs);
  await f.expire();
  assert.equal(homeRevokes(f), asked, "upkeep doesn't ask Home about it again");

  // The person's own revoke, through the setup host, deletes the tools token and finishes it.
  assert.equal((await f.action("revoke", member, computer.intent, { id })).status, 200);
  assert.equal((await f.action("revoked", member, computer.intent, { id })).status, 200);
  assert.equal((await row(f, id))?.state, "revoked");
});

test("an interrupted web setup's issuing row is removed by upkeep; one still in progress stays", async () => {
  const f = fixture();
  const unclaimed = await f.create(member, pool, false);
  // Its link lapses unclaimed; the row keeps its key id.
  f.advance(2 * interruptedSetupMs);
  await f.expire();
  assert.equal((await row(f, unclaimed.computer.id))?.link, undefined);
  const setup = (id: string, createdAt: number): StoredComputer => ({
    id,
    name: "Laptop",
    user: member,
    pool: pool.pool,
    createdAt: new Date(createdAt).toISOString(),
    boundAt: new Date(createdAt).toISOString(),
    state: "issuing",
    firstModelRequestAt: null,
    firstToolCallAt: null,
    revokedAt: null,
  });
  await leave(f, (registry) => {
    registry.interrupted = setup("interrupted", f.now() - interruptedSetupMs);
    registry["in-progress"] = setup("in-progress", f.now() - interruptedSetupMs + 60_000);
  });
  // A key a lost mint reply left at Home for the interrupted setup.
  f.server.keys.push({
    api_key_id: 900,
    id: 900,
    display_name: `${brand.setup.id}:interrupted`,
  });
  await f.expire();
  const registry = await f.registry();
  assert.equal(registry.interrupted, undefined, "the interrupted setup's row is gone");
  assert.equal(holds(f, 900), false, "and so is the key Home kept for it");
  assert.equal(registry["in-progress"]?.state, "issuing", "a setup still under way stays");
  assert.equal(registry[unclaimed.computer.id]?.state, "issuing", "an unclaimed link stays");
});

test("a person's revoke and upkeep share one Home revocation per computer", async () => {
  const f = fixture();
  const device = await nativeDevice(f, true);
  const computer = (await row(f, device.id))!;
  let release!: () => void;
  f.server.revokeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Upkeep asks Home outside the registry queue, and a person's revoke may enter it meanwhile.
  // Which one gets there first isn't observable from outside, so the sharing is driven directly.
  const { ComputerLeftovers } = await import("./computer-leftovers.ts");
  const unused = () => Promise.reject(new Error("not used here"));
  const { revocableKeys } = await import("./native-computers.ts");
  const leftovers = new ComputerLeftovers({
    home: f.home,
    keys: (computer) => revocableKeys(computer, f.home),
    now: f.now,
    run: unused,
    save: unused,
  });
  const asked = homeRevokes(f);
  const first = leftovers.revokeKeys(computer);
  const second = leftovers.revokeKeys(computer);
  assert.equal(second, first, "the second caller waits for the first");
  release();
  await Promise.all([first, second]);
  assert.equal(homeRevokes(f), asked + 1, "Home was asked once");
});
