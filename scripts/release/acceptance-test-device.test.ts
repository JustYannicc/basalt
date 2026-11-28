import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { nativeControlPath, nativeControlPrefix } from "../../src/pool/native-contract.ts";
import { fixture, signingKey } from "../../src/pool/test/computers.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { acceptanceCredential } from "./acceptance-device.ts";
import {
  acceptanceTestDevice,
  isAcceptanceIdentity,
  registerAcceptanceTestDevice,
  revokeAcceptanceTestDevice,
  testDeviceSecret,
} from "./acceptance-test-device.ts";

const testPool = "app_acceptance0load1";
const receipt = {
  migration: "acceptance-pool-setup-v1",
  organization: "acceptance",
  status: "applied",
  app: testPool,
};
const input = {
  stage: "production",
  signingKey,
  receipt,
  pool: testPool,
  owner: "acceptance",
  organization: "acceptance",
  user: "acceptance",
};
const device = {
  computer: "computer-7c1d",
  grant: "native:acceptance-test-2e9a",
  user: "acceptance",
  pool: testPool,
  owner: "acceptance",
  organization: "acceptance",
};
const untouched: typeof fetch = async () => assert.fail("nothing may be sent");

/** A pool registry holding the test pool, made for the acceptance identity alone. */
async function testPoolRegistry() {
  const f = fixture();
  const seeded = await f.access({
    action: "audience",
    pools: [
      {
        pool: testPool,
        owner: "acceptance",
        organization: "acceptance",
        name: "acceptance-load",
        users: ["acceptance"],
      },
    ],
  });
  assert.equal(seeded.status, 200, await seeded.clone().text());
  return f;
}

test("on production the test pool's own registration makes a models-only device, at the product's host", async () => {
  const f = await testPoolRegistry();
  const sent: string[] = [];
  const registered = await registerAcceptanceTestDevice(
    input,
    async (url, init) => {
      sent.push(String(url));
      return f.nativeControl(new Request(url, init));
    },
    f.now,
  );
  assert.deepEqual(sent, [`https://${brand.host}${nativeControlPath}`]);
  assert.deepEqual(Object.keys(registered).sort(), [
    "computer",
    "grant",
    "organization",
    "owner",
    "pool",
    "user",
  ]);
  assert.match(registered.grant, /^native:acceptance-test-/u);
  assert.equal(registered.pool, testPool);
  const row = (await f.registry())[registered.computer];
  assert.equal(row?.state, "active");
  assert.equal(row?.native?.models, true);
  // The lane reads it from its own secret and signs model calls the pool admits.
  const env = { [testDeviceSecret]: JSON.stringify(registered), POOL_APP_SIGNING_KEY: signingKey };
  assert.deepEqual(acceptanceTestDevice(env), registered);
  const credential = acceptanceCredential(env, f.now, testDeviceSecret);
  const admitted = await f.nativeModel(
    new Request("https://pool.example/v1/models", {
      headers: await credential("GET", "/v1/models"),
    }),
  );
  admitted.release();
  assert.ok(admitted.request.headers.get("authorization"));
});

test("only the acceptance identity throughout, never a person, gets a test device", async () => {
  for (const field of ["user", "owner", "organization"] as const)
    await assert.rejects(
      registerAcceptanceTestDevice({ ...input, [field]: "user-ada" }, untouched),
      /acceptance identity/u,
      field,
    );
  assert.equal(isAcceptanceIdentity(device), true);
  for (const field of ["user", "owner", "organization"] as const)
    assert.equal(isAcceptanceIdentity({ ...device, [field]: "acceptance " }), false, field);
});

test("the pool must be the one the applied setup receipt created for acceptance", async () => {
  const refusals: [object, RegExp][] = [
    [{ pool: "app_someone0else" }, /not the one the acceptance-pool setup receipt created/u],
    [{ receipt: { ...receipt, migration: "acceptance-pool-teardown-v1" } }, /setup receipt/u],
    [{ receipt: { ...receipt, organization: "organization-a" } }, /setup receipt/u],
    [{ receipt: { ...receipt, status: "planned" } }, /setup receipt/u],
    [{ receipt: { ...receipt, app: "acceptance-run-7" } }, /setup receipt/u],
    [{ receipt: undefined }, /setup receipt/u],
  ];
  for (const [extra, why] of refusals)
    await assert.rejects(
      registerAcceptanceTestDevice({ ...input, ...extra }, untouched),
      why,
      JSON.stringify(extra),
    );
});

test("only production or a rehearsal stage, each at its own host, and only with a real key", async () => {
  for (const stage of ["staging", "test-x", "", "Production"])
    await assert.rejects(
      registerAcceptanceTestDevice({ ...input, stage }, untouched),
      /production or a test-rehearsal-<n> stage/u,
      stage,
    );
  await assert.rejects(
    registerAcceptanceTestDevice({ ...input, origin: "https://pool.example" }, untouched),
    /product's own app host/u,
  );
  await assert.rejects(
    registerAcceptanceTestDevice({ ...input, signingKey: "abc" }, untouched),
    /signing key/u,
  );
  // A rehearsal stage is reached at its own app host, never production's.
  await assert.rejects(
    registerAcceptanceTestDevice(
      { ...input, stage: "test-rehearsal-3", origin: `https://${brand.host}` },
      untouched,
    ),
    /production's host/u,
  );
  let sent: string | undefined;
  await registerAcceptanceTestDevice(
    { ...input, stage: "test-rehearsal-3", origin: "https://app.rehearsal-3.stage.example" },
    async (url) => {
      sent = String(url);
      return new Response(null, { status: 403 });
    },
  ).catch(() => {});
  assert.equal(sent, `https://app.rehearsal-3.stage.example${nativeControlPath}`);
});

test("a refused or foreign registration reply leaves no device", async () => {
  await assert.rejects(
    registerAcceptanceTestDevice(input, async () => new Response(null, { status: 403 })),
    /refused the registration \(HTTP 403\)/u,
  );
  await assert.rejects(
    registerAcceptanceTestDevice(input, async () =>
      Response.json({ computer: { id: "computer-1" }, pool: "app_other" }),
    ),
    /named no device in this pool/u,
  );
});

test("teardown revokes the test device, and a repeated revoke is answered the same", async () => {
  const f = await testPoolRegistry();
  const send: typeof fetch = async (url, init) => f.nativeControl(new Request(url, init));
  const registered = await registerAcceptanceTestDevice(input, send, f.now);
  const envelopes: unknown[] = [];
  const recording: typeof fetch = async (url, init) => {
    envelopes.push(
      await openEnvelope(
        signingKey,
        nativeControlPrefix,
        (JSON.parse(String(init?.body)) as { envelope: string }).envelope,
      ),
    );
    return send(url, init);
  };
  const target = { stage: "production", signingKey, receipt, device: registered };
  await revokeAcceptanceTestDevice(target, recording, f.now);
  await revokeAcceptanceTestDevice(target, recording, f.now);
  assert.equal((await f.registry())[registered.computer]?.state, "revoked");
  assert.deepEqual(
    envelopes.map((value) => ({ ...(value as object), expiresAt: 0 })),
    Array(2).fill({
      action: "revoke",
      user: "acceptance",
      grant: registered.grant,
      computer: registered.computer,
      pool: testPool,
      expiresAt: 0,
    }),
  );
});

test("a device of a person, or of another pool, is never revoked here", async () => {
  for (const extra of [{ user: "user-ada" }, { owner: "user-ada" }, { pool: "app_someone0else" }])
    await assert.rejects(
      revokeAcceptanceTestDevice(
        { stage: "production", signingKey, receipt, device: { ...device, ...extra } },
        untouched,
      ),
      /acceptance identity|setup receipt created/u,
      JSON.stringify(extra),
    );
  await assert.rejects(
    revokeAcceptanceTestDevice(
      { stage: "production", signingKey, receipt, device },
      async () => new Response(null, { status: 404 }),
    ),
    /refused the revoke \(HTTP 404\)/u,
  );
});

test("the test device's secret is read by its own name, and a malformed one names no id", () => {
  assert.throws(
    () => acceptanceTestDevice({}),
    (error: { field?: string; why?: string }) =>
      error.field === testDeviceSecret && error.why === "unset",
  );
  // The release's device in its own secret is never taken for the test device.
  assert.throws(
    () => acceptanceTestDevice({ POOL_ACCEPTANCE_DEVICE: JSON.stringify(device) }),
    (error: { field?: string; why?: string }) =>
      error.field === testDeviceSecret && error.why === "unset",
  );
  const { owner: _owner, ...withoutOwner } = device;
  assert.throws(
    () => acceptanceTestDevice({ [testDeviceSecret]: JSON.stringify(withoutOwner) }),
    (error: { why?: string; message?: string }) =>
      error.why === "malformed" && !String(error.message).includes(device.computer),
  );
});
