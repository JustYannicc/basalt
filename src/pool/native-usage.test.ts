import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
} from "./native-contract.ts";
import { nativeUsagePath, type NativeUsage } from "./native-usage-contract.ts";
import { poolGroupPrefix } from "./pool-group.ts";
import { signEnvelope } from "./token.ts";

const sessions = {
  own: "6f1c3a52-0d4e-4c1b-9a77-2f0e5b8d1c01",
  second: "6f1c3a52-0d4e-4c1b-9a77-2f0e5b8d1c02",
  theirs: "6f1c3a52-0d4e-4c1b-9a77-2f0e5b8d1c03",
};

/** Two registered models devices in one pool: the owner's and a member's. */
async function devices() {
  const f = fixture();
  const register = async (user: string, grant: string) => {
    const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
      action: "register",
      user,
      grant,
      models: true,
      tools: false,
      name: "Acceptance device",
      intent: await f.intent(user),
      expiresAt: f.now() + 10_000,
    });
    const response = await f.nativeControl(
      new Request(`https://pool.example${nativeControlPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const { computer } = (await response.json()) as { computer: { id: string } };
    return { user, grant, computer: computer.id };
  };
  // A device's model key is minted by its first model call.
  const firstModelCall = async (device: Awaited<ReturnType<typeof register>>) => {
    const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
      ...device,
      pool: pool.pool,
      method: "POST",
      path: "/v1/responses",
      expiresAt: f.now() + 10_000,
    });
    const lease = await f.nativeModel(
      new Request("https://pool.example/v1/responses", {
        method: "POST",
        headers: { [nativeModelHeader]: assertion },
        body: "{}",
      }),
    );
    lease.release();
    return { ...device, keyId: (await f.registry())[device.computer]!.keyId! };
  };
  const keyless = await register(owner, "native:keyless-device");
  const mine = await firstModelCall(await register(owner, "native:acceptance-device"));
  const theirs = await firstModelCall(await register(member, "native:member-device"));
  const group = f.server.groups.find(
    (row) => row.channel_name === `${poolGroupPrefix}${pool.pool}`,
  )!;
  // A pool with many members: every one of these accounts may serve the device.
  f.server.members = Array.from({ length: 9 }, (_, index) => ({
    id: index + 1,
    channel_group_id: group.id,
    auth_id: `pool-account-${index + 1}`,
  }));
  const row = (session: string, keyId: number, account: string, status = "success") => ({
    id: `usage-${f.server.usage.length + 1}`,
    session_id: session,
    status,
    timestamp: "2026-01-01T00:00:01.000000Z",
    client: { api_key_id: keyId },
    credential: { credential_id: account },
  });
  type Device = Awaited<ReturnType<typeof register>>;
  const read = async (
    device: Device,
    query: string,
    values: Record<string, unknown> = {},
    method = "GET",
  ) => {
    const path = query ? `${nativeUsagePath}?${query}` : nativeUsagePath;
    const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
      user: device.user,
      grant: device.grant,
      computer: device.computer,
      pool: pool.pool,
      method,
      path,
      expiresAt: f.now() + 10_000,
      ...values,
    });
    return f.nativeUsage(
      new Request(`https://pool.example${path}`, {
        method,
        headers: { [nativeModelHeader]: assertion },
      }),
    );
  };
  const body = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as NativeUsage;
  };
  return { f, keyless, mine, theirs, row, read, body };
}

test("a device reads its own sessions' rows, each with whether its account is in its pool", async () => {
  const d = await devices();
  d.f.server.usage.push(
    d.row(sessions.own, d.mine.keyId, "pool-account-7"),
    d.row(sessions.second, d.mine.keyId, "pool-account-2", "failed"),
    d.row(sessions.second, d.mine.keyId, "pool-account-9"),
  );
  const before = d.f.server.calls.length;
  const usage = await d.body(
    await d.read(d.mine, `session=${sessions.own}&session=${sessions.second}`),
  );
  assert.equal(usage.key, d.mine.keyId);
  assert.deepEqual(
    usage.sessions.map(({ session, complete, records }) => ({
      session,
      complete,
      records: records.map(({ status, key, account, inPool }) => ({
        status,
        key,
        account,
        inPool,
      })),
    })),
    [
      {
        session: sessions.own,
        complete: true,
        records: [
          { status: "success", key: d.mine.keyId, account: "pool-account-7", inPool: true },
        ],
      },
      {
        session: sessions.second,
        complete: true,
        records: [
          { status: "failed", key: d.mine.keyId, account: "pool-account-2", inPool: true },
          { status: "success", key: d.mine.keyId, account: "pool-account-9", inPool: true },
        ],
      },
    ],
  );
  // Membership, then one lookup per session by its session index and the device's own key.
  const reads = d.f.server.calls.slice(before);
  assert.deepEqual(
    reads
      .filter(({ path }) => path === "/usage/records")
      .map(({ search }) => {
        const query = new URLSearchParams(search);
        return [query.get("session_id"), query.get("client_key_id")];
      }),
    [
      [sessions.own, String(d.mine.keyId)],
      [sessions.second, String(d.mine.keyId)],
    ],
  );
  assert.ok(reads.length <= 4, reads.map(({ path }) => path).join(", "));
});

test("a row served by another pool's account is reported outside the pool and never named", async () => {
  const d = await devices();
  d.f.server.usage.push(d.row(sessions.own, d.mine.keyId, "someone-elses-account"));
  const usage = await d.body(await d.read(d.mine, `session=${sessions.own}`));
  const [record] = usage.sessions[0]!.records;
  assert.equal(record?.inPool, false);
  assert.equal(record?.account, null);
  assert.doesNotMatch(JSON.stringify(usage), /someone-elses-account/u);
});

test("someone else's sessions, or another device's assertion, return none of their rows", async () => {
  const d = await devices();
  d.f.server.usage.push(
    d.row(sessions.theirs, d.theirs.keyId, "pool-account-3"),
    d.row(sessions.own, d.mine.keyId, "pool-account-4"),
  );
  // Naming another device's session returns nothing, not even that it exists.
  const named = await d.body(await d.read(d.mine, `session=${sessions.theirs}`));
  assert.deepEqual(named.sessions, [{ session: sessions.theirs, complete: true, records: [] }]);
  // The other device's own assertion reads only its own key's rows.
  const other = await d.body(await d.read(d.theirs, `session=${sessions.own}`));
  assert.equal(other.key, d.theirs.keyId);
  assert.deepEqual(other.sessions[0]!.records, []);
  // Even a Home that ignores the key filter cannot hand back another key's rows.
  d.f.server.usageIgnoresKey = true;
  const unfiltered = await d.body(
    await d.read(d.mine, `session=${sessions.theirs}&session=${sessions.own}`),
  );
  assert.deepEqual(unfiltered.sessions[0]!.records, []);
  assert.deepEqual(
    unfiltered.sessions[1]!.records.map(({ key }) => key),
    [d.mine.keyId],
  );
});

test("an assertion made for another device, request or moment is refused before any read", async () => {
  const d = await devices();
  const query = `session=${sessions.own}`;
  const before = d.f.server.calls.length;
  const refusals: [string, Response][] = [
    ["expired", await d.read(d.mine, query, { expiresAt: d.f.now() - 1 })],
    ["too far ahead", await d.read(d.mine, query, { expiresAt: d.f.now() + 31_000 })],
    ["another path", await d.read(d.mine, query, { path: "/v1/chat/completions" })],
    [
      "another query",
      await d.read(d.mine, query, { path: `${nativeUsagePath}?session=${sessions.theirs}` }),
    ],
    ["another method", await d.read(d.mine, query, { method: "POST" })],
    ["another person's device", await d.read(d.mine, query, { user: member })],
    ["another pool", await d.read(d.mine, query, { pool: "foreign-pool" })],
    ["another grant", await d.read(d.mine, query, { grant: "native:another-device" })],
  ];
  for (const [why, response] of refusals) assert.equal(response.status, 401, why);
  // A model call's assertion is bound to its own path, so it cannot be replayed here.
  const model = await signEnvelope(signingKey, nativeModelPrefix, {
    user: owner,
    grant: d.mine.grant,
    computer: d.mine.computer,
    pool: pool.pool,
    method: "POST",
    path: "/v1/chat/completions",
    expiresAt: d.f.now() + 10_000,
  });
  const replay = await d.f.nativeUsage(
    new Request(`https://pool.example${nativeUsagePath}?${query}`, {
      headers: { [nativeModelHeader]: model },
    }),
  );
  assert.equal(replay.status, 401);
  assert.equal(
    (await d.f.nativeUsage(new Request(`https://pool.example${nativeUsagePath}?${query}`))).status,
    401,
  );
  assert.equal(d.f.server.calls.length, before, "nothing was read from Home");
});

test("a keyless or revoked device is refused, and a read names a bounded set of sessions only", async () => {
  const d = await devices();
  // Approved before its key was minted: it has made no model calls to read.
  assert.equal((await d.read(d.keyless, `session=${sessions.own}`)).status, 403);
  const many = Array.from({ length: 21 }, (_, index) => `session=s-${index}`).join("&");
  for (const query of [
    "",
    many,
    `session=${sessions.own}&key=1`,
    `session=${sessions.own}&limit=200`,
  ])
    assert.equal((await d.read(d.mine, query)).status, 400, query);
  const registry = await d.f.registry();
  registry[d.mine.computer]!.state = "revoked";
  await d.f.storage.put("computer-registry-v1", registry);
  d.f.restart();
  assert.equal((await d.read(d.mine, `session=${sessions.own}`)).status, 401);
});
