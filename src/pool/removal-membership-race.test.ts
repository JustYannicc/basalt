import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { HomeMembership } from "./home-membership.ts";
import { HomeTransportFailure } from "./json.ts";
import { NativeMemberships } from "./membership.ts";
import { membershipPrefix } from "./membership-contract.ts";
import { PoolAccountRemovals } from "./account-removals.ts";
import { handleRemovalIntent, removalIntentPath, removalIntentPrefix } from "./removal-intent.ts";
import { signEnvelope } from "./token.ts";

const key = "12".repeat(32);
const now = Date.UTC(2026, 10, 8);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const phase of ["reconcile", "install"] as const)
  for (const newest of [[], ["other"], ["account"]])
    test(`native removal converges after a reservation during ${phase} to ${JSON.stringify(newest)}`, async () => {
      const values = new Map<string, unknown>();
      const storage = {
        get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
        put: async (name: string, value: unknown) => {
          values.set(name, structuredClone(value));
        },
      };
      const history = new PoolAccountRemovals(storage);
      let native = ["account"],
        home = ["account"];
      let hold = false;
      const entered = deferred(),
        release = deferred();
      const memberships = new NativeMemberships({
        storage,
        signingKey: key,
        now: () => now,
        read: async (pool, organization) => ({
          pool,
          organization,
          native: true,
          accounts: native.map((id) => ({
            account: id,
            requirement: "openai",
            provider: "OpenAI",
            method: "chatgpt",
            generation: 1,
            driver: "basalt-home",
            driverRevision: "1",
            bindingRevision: "1",
            homeReference: id,
          })),
        }),
        actual: async () => home,
        reconcile: async (_pool, accounts) => {
          if (hold && phase === "reconcile") {
            hold = false;
            entered.resolve();
            await release.promise;
          }
          home = [...accounts];
        },
        install: async (policy) => {
          if (hold && phase === "install" && !policy.dirty) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
        },
        abort: () => {},
        schedule: async () => {},
      });
      const reserve = async () =>
        memberships.reserve(
          new Request("https://pool.test/pool/v1/membership", {
            method: "POST",
            body: JSON.stringify({
              envelope: await signEnvelope(key, membershipPrefix, {
                pool: "pool",
                organization: "org",
                at: now,
                expiresAt: now + 30_000,
              }),
            }),
          }),
        );
      await reserve();
      await memberships.refresh("pool");
      native = [];
      hold = true;
      const removing = handleRemovalIntent(
        new Request(`https://pool.test${removalIntentPath}`, {
          method: "POST",
          body: JSON.stringify({
            envelope: await signEnvelope(key, removalIntentPrefix, {
              audience: removalIntentPath,
              pool: "pool",
              reference: "account",
              actor: "person",
              operation: "remove-1",
              at: now,
              expiresAt: now + 30_000,
            }),
          }),
        }),
        {
          signingKey: key,
          now: () => now,
          refresh: (pool) => memberships.refresh(pool),
          selected: async (pool) => (await memberships.authority(pool))!.accounts,
          record: (pool, refs, actor, operation, issuedAt) =>
            history.recordMany(pool, refs, actor, new Date(now), operation, issuedAt),
        },
      );
      await entered.promise;
      native = newest;
      await reserve();
      const joined = memberships.refresh("pool");
      release.resolve();
      const response = await removing;
      await joined;
      assert.deepEqual(home, newest);
      assert.equal(
        response.status,
        newest.includes("account") ? 409 : 204,
        "a committed Home unlink must retain its receipt across a newer signed reservation",
      );
      assert.deepEqual(
        (await history.read("pool")).items,
        newest.includes("account")
          ? []
          : [{ account: "account", actor: "person", at: new Date(now).toISOString() }],
      );
      assert.deepEqual((await memberships.authority("pool"))?.accounts, newest);
    });

test("the same unlink retries a failed policy install without repeating Home deletion or its receipt", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
    put: async (name: string, value: unknown) => {
      values.set(name, structuredClone(value));
    },
  };
  const history = new PoolAccountRemovals(storage);
  const members = [{ id: 1, channel_group_id: 1, auth_id: "account" }];
  let deletes = 0,
    unlinked = false,
    failInstall = false;
  const home = new HomeMembership(
    new HomeClient(async (path, init) => {
      const route = new URL(path, "http://home.test").pathname.replace("/v8/management", "");
      if (route === "/channel-groups")
        return Response.json({ channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool" }] });
      if (init?.method === "DELETE") {
        assert.equal(route, "/channel-group-details/1");
        assert.equal(members.length, 1, "a removed Home membership must never be deleted twice");
        members.pop();
        deletes++;
        return new Response(null, { status: 204 });
      }
      assert.ok(
        !init?.method || init.method === "GET",
        "retry must not create or remove a credential",
      );
      return Response.json({ channel_group_details: members });
    }),
  );
  const memberships = new NativeMemberships({
    storage,
    signingKey: key,
    now: () => now,
    read: async (pool, organization) => ({
      pool,
      organization,
      native: true,
      accounts: unlinked
        ? []
        : [
            {
              account: "account",
              requirement: "openai",
              provider: "OpenAI",
              method: "chatgpt",
              generation: 1,
              driver: "basalt-home",
              driverRevision: "1",
              bindingRevision: "1",
              homeReference: "account",
            },
          ],
    }),
    actual: (pool) => home.actual(pool),
    reconcile: (pool, accounts) => home.reconcile(pool, accounts),
    install: async () => {
      if (failInstall) throw new HomeTransportFailure("transport");
    },
    abort: () => {},
    schedule: async () => {},
  });
  await memberships.ensure("pool", "org");
  unlinked = true;
  failInstall = true;
  const body = JSON.stringify({
    envelope: await signEnvelope(key, removalIntentPrefix, {
      audience: removalIntentPath,
      pool: "pool",
      reference: "account",
      actor: "person",
      operation: "same-unlink",
      at: now,
      expiresAt: now + 30_000,
    }),
  });
  const unlink = () =>
    handleRemovalIntent(
      new Request(`https://pool.test${removalIntentPath}`, {
        method: "POST",
        body,
      }),
      {
        signingKey: key,
        now: () => now,
        refresh: (pool) => memberships.refresh(pool),
        selected: async (pool) => (await memberships.authority(pool))!.accounts,
        record: (pool, refs, actor, operation, issuedAt) =>
          history.recordMany(pool, refs, actor, new Date(now), operation, issuedAt),
      },
    );
  assert.equal((await unlink()).status, 503);
  assert.deepEqual(await home.actual("pool"), []);
  assert.deepEqual((await history.read("pool")).items, []);
  await assert.rejects(memberships.authority("pool"), /refreshing/);
  failInstall = false;
  assert.equal((await unlink()).status, 204);
  const receipt = { account: "account", actor: "person", at: new Date(now).toISOString() };
  assert.deepEqual((await history.read("pool")).items, [receipt]);
  assert.deepEqual((await memberships.authority("pool"))?.accounts, []);
  assert.equal((await unlink()).status, 409);
  assert.deepEqual((await history.read("pool")).items, [receipt]);
  assert.equal(deletes, 1);
});
