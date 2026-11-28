import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolView } from "../../apps/pool/contract.ts";
import { NativeMemberships } from "./membership.ts";
import { membershipPrefix, type NativeMembershipSnapshot } from "./membership-contract.ts";
import { signEnvelope } from "./token.ts";
import { fixture as controlFixture } from "./test/control.ts";

const key = "3a".repeat(32);

const linked = (account: string, homeReference: string) => ({
  account,
  requirement: "openai",
  provider: "OpenAI",
  method: "chatgpt",
  generation: 1,
  driver: "basalt-home",
  driverRevision: "1",
  bindingRevision: "1",
  homeReference,
});

/** A control path as the pool Worker wires it: the membership gate, then the view. */
async function wired() {
  const control = await controlFixture();
  control.home.addFile("checked");
  control.home.addGroup("pool-a", 10, ["checked"]);
  const values = new Map<string, unknown>();
  const home = new Map<string, string[]>();
  let now = 1_000_000;
  let gateReads = 0,
    viewReads = 0;
  /** The saved accounts the host links to the Home credential the pool view lists. */
  let saved = ["saved-account"];
  const snapshot = (pool: string, organization: string): NativeMembershipSnapshot => ({
    pool,
    organization,
    native: true,
    accounts: saved.map((account) => linked(account, "checked")),
  });
  const memberships = new NativeMemberships({
    storage: {
      get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => {
        values.set(name, structuredClone(value));
      },
    },
    signingKey: key,
    now: () => now,
    read: async (pool, organization) => {
      gateReads++;
      return snapshot(pool, organization);
    },
    actual: async (pool) => home.get(pool) ?? [],
    reconcile: async (pool, accounts) => {
      home.set(pool, [...accounts]);
    },
    install: async () => {},
    abort: () => {},
    schedule: async () => {},
  });
  Object.assign(control.deps, {
    nativeMembership: async (pool: string, organization: string) => {
      viewReads++;
      return snapshot(pool, organization);
    },
    nativeIdentities: (pool: string) => memberships.identities(pool),
  });
  control.restart();
  const reserve = async () =>
    memberships.reserve(
      new Request("https://pool/pool/v1/membership", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(key, membershipPrefix, {
            pool: "pool-a",
            organization: "fake-org",
            at: now,
            expiresAt: now + 30_000,
          }),
        }),
      }),
    );
  /** One view request: the gate, then GET /pool; the host reads each one made. */
  const view = async () => {
    const [gate, viewed] = [gateReads, viewReads];
    await memberships.ensure("pool-a", "fake-org");
    const body = (await (await control.call("/pool")).json()) as PoolView;
    return { body, gate: gateReads - gate, view: viewReads - viewed };
  };
  return {
    memberships,
    reserve,
    view,
    values,
    link: (accounts: string[]) => {
      saved = accounts;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const annotation = (body: PoolView) =>
  body.accounts.find((account) => account.id === "checked")?.nativeAccountId;

test("a pool view reads membership from the host at most once, and not at all while the gate's state is fresh", async () => {
  const f = await wired();
  await f.reserve();
  // A reservation leaves the state dirty: the gate reads, and the view uses what it read.
  const first = await f.view();
  assert.deepEqual([first.gate, first.view], [1, 0], "the gate's read only");
  assert.equal(annotation(first.body), "saved-account");
  // With the gate's state fresh, a view reads membership from the host not at all.
  f.advance(2_000);
  const fresh = await f.view();
  assert.deepEqual([fresh.gate, fresh.view], [0, 0], "no host read");
  assert.equal(annotation(fresh.body), "saved-account");
});

test("a state written before the mapping was kept falls back to one host read for the view", async () => {
  const f = await wired();
  await f.reserve();
  await f.view();
  // Drop the mapping, as a state saved by the previous release has none.
  const states = f.values.get("native-pool-memberships-v1") as Record<
    string,
    Record<string, unknown>
  >;
  delete states["pool-a"]!.identities;
  f.values.set("native-pool-memberships-v1", states);
  f.advance(2_000);
  const older = await f.view();
  assert.deepEqual([older.gate, older.view], [0, 1], "the view's own host read, as before");
  assert.equal(annotation(older.body), "saved-account");
});

test("a host read that relinks a Home reference updates the view's mapping, and an unchanged one changes only the lease", async () => {
  const f = await wired();
  await f.reserve();
  await f.view();
  // Same Home reference, another saved account: the reference set is unchanged, the mapping is not.
  f.link(["other-account"]);
  await f.memberships.readAll();
  f.advance(2_000);
  const relinked = await f.view();
  assert.deepEqual([relinked.gate, relinked.view], [0, 0], "no host read");
  assert.equal(annotation(relinked.body), "other-account");
  // The pass still renews the lease; an unchanged mapping must change nothing else.
  const lease = new Set(["expiresAt", "checkedAt", "installedUntil", "installedGraceUntil"]);
  const unleased = () =>
    Object.entries(
      (f.values.get("native-pool-memberships-v1") as Record<string, Record<string, unknown>>)[
        "pool-a"
      ]!,
    ).filter(([field]) => !lease.has(field));
  const before = unleased();
  await f.memberships.readAll();
  assert.deepEqual(unleased(), before, "an unchanged read keeps the stored mapping");
  // A reference two saved accounts share names neither, as the host's own snapshot did.
  f.link(["other-account", "saved-account"]);
  await f.memberships.readAll();
  assert.equal(annotation((await f.view()).body), null);
});
