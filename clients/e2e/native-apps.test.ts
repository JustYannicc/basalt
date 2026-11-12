import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceSocket } from "../cli/device-socket.ts";
import { deviceConnection } from "../connection/device.ts";
import { signInDevice } from "../connection/device-oauth.ts";
import { nativeFixture } from "./native-fixture.ts";

/** The connection reads the app list itself; no file or OS credential store is involved. */
async function connected(remote: Awaited<ReturnType<typeof nativeFixture>>) {
  remote.approve();
  const credentials = await signInDevice(remote.origin, {
    signal: AbortSignal.timeout(20_000),
    show: async () => undefined,
  });
  let stored = JSON.stringify(credentials);
  const source = deviceConnection(
    credentials,
    {
      read: async () => stored,
      write: async (value) => {
        stored = value;
      },
      remove: async () => {
        stored = "";
      },
    },
    deviceSocket,
  );
  await source.reconnect();
  return source;
}

const inventory = (extra: Record<string, unknown> = {}) => ({
  apps: [
    { id: "gmail", name: "Gmail" },
    { id: "linear", name: "Linear" },
  ],
  links: [
    { app: "gmail", account: "personal" },
    { app: "gmail", account: "personal" },
  ],
  appLinks: [],
  accounts: [],
  accountSetup: { redirectUri: "https://signalbox.example/callback" },
  ...extra,
});

test("the app list uses the server's counts, then the caller's own distinct links", async () => {
  const remote = await nativeFixture();
  try {
    const source = await connected(remote);
    remote.inventory(200, inventory({ accountCounts: [{ app: "gmail", count: 3 }] }));
    assert.deepEqual(await source.apps(AbortSignal.timeout(5_000)), {
      organization: "personal-tools",
      apps: [
        { id: "gmail", name: "Gmail", accounts: 3 },
        { id: "linear", name: "Linear", accounts: 0 },
      ],
    });
    remote.inventory(200, inventory());
    const fallback = await source.apps(AbortSignal.timeout(5_000));
    assert.deepEqual(
      fallback?.apps.map(({ accounts }) => accounts),
      [1, 0],
    );
  } finally {
    await remote.close();
  }
});

test("a failed app list leaves the connection usable", async () => {
  const remote = await nativeFixture();
  try {
    const source = await connected(remote);
    const before = remote.counts();
    remote.inventory(503);
    await assert.rejects(source.apps(AbortSignal.timeout(5_000)));
    assert.equal(source.view().state, "connected");
    assert.equal(remote.counts().accessReads, before.accessReads, "The read never re-validates.");
    remote.inventory(200, inventory());
    assert.equal((await source.apps(AbortSignal.timeout(5_000)))?.apps.length, 2);
  } finally {
    await remote.close();
  }
});

test("an expiring grant renews once through the shared renewal before listing", async () => {
  const remote = await nativeFixture();
  try {
    remote.expireNext(10);
    const source = await connected(remote);
    const before = remote.counts().refreshes;
    remote.inventory(200, inventory());
    assert.equal((await source.apps(AbortSignal.timeout(5_000)))?.apps.length, 2);
    assert.equal(remote.counts().refreshes, before + 1);
    assert.equal(source.view().state, "connected");
  } finally {
    await remote.close();
  }
});

test("a lost renewal replays the same pair before listing apps", async () => {
  const remote = await nativeFixture();
  try {
    remote.expireNext(10);
    const source = await connected(remote);
    const before = remote.counts();
    const presented = `synthetic-refresh-${before.rotations + 1}`;
    remote.expireNext(3600);
    remote.loseRefresh();
    await assert.rejects(source.apps(AbortSignal.timeout(5_000)));
    assert.equal(source.view().state, "connected");
    assert.equal(remote.inventoryReads(), 0);
    remote.inventory(200, inventory());
    assert.equal((await source.apps(AbortSignal.timeout(5_000)))?.apps.length, 2);
    assert.deepEqual(remote.refreshTokens().slice(before.refreshes), [presented, presented]);
    assert.equal(
      remote.counts().rotations,
      before.rotations + 1,
      "Replay must not issue another pair.",
    );
    assert.equal(source.view().state, "connected");
  } finally {
    await remote.close();
  }
});

test("a definitive renewal refusal requires sign-in without another exchange", async () => {
  const remote = await nativeFixture();
  try {
    remote.expireNext(10);
    const source = await connected(remote);
    remote.refuseRefresh();
    await assert.rejects(source.apps(AbortSignal.timeout(5_000)));
    assert.equal(source.view().state, "sign-in-required");
    const before = remote.counts().refreshes;
    await assert.rejects(source.apps(AbortSignal.timeout(5_000)));
    assert.equal(remote.counts().refreshes, before);
    assert.equal(remote.inventoryReads(), 0);
  } finally {
    await remote.close();
  }
});

test("without a tools grant there is no app list to read", async () => {
  const remote = await nativeFixture();
  try {
    remote.toolsOrganization(undefined);
    const source = await connected(remote);
    assert.equal(await source.apps(AbortSignal.timeout(5_000)), undefined);
    assert.equal(remote.inventoryReads(), 0);
  } finally {
    await remote.close();
  }
});
