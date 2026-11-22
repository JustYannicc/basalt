import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { nativeControlPath } from "../../src/pool/native-contract.ts";
import { fixture, owner, pool, signingKey } from "../../src/pool/test/computers.ts";
import { acceptanceCredential } from "./acceptance-device.ts";
import { registerRehearsalAcceptanceDevice } from "./rehearsal-acceptance-device.ts";

const input = {
  stage: "test-rehearsal-3",
  // The stage's app host, as its stack names it: the stage's DNS label under the stage domain.
  origin: "https://app.rehearsal-3.stage.example",
  signingKey,
  pool: pool.pool,
  owner,
  organization: pool.organization,
  user: owner,
};
const untouched: typeof fetch = async () => assert.fail("nothing may be sent");

test("the production stage is refused by name before anything else is read or sent", async () => {
  for (const extra of [{}, { signingKey: "", origin: "", pool: "" }]) {
    await assert.rejects(
      registerRehearsalAcceptanceDevice({ ...input, ...extra, stage: "production" }, untouched),
      /never registered on production/u,
    );
  }
});

test("only a test-rehearsal-<n> stage, never production's host, registers a device", async () => {
  for (const stage of ["test-x", "test-rehearsal-10", "test-rehearsal-1-x", "scale-1", ""])
    await assert.rejects(
      registerRehearsalAcceptanceDevice({ ...input, stage }, untouched),
      /test-rehearsal-<n>/u,
      stage,
    );
  await assert.rejects(
    registerRehearsalAcceptanceDevice({ ...input, origin: `https://${brand.host}` }, untouched),
    /production's host/u,
  );
  await assert.rejects(
    registerRehearsalAcceptanceDevice({ ...input, signingKey: "abc" }, untouched),
    /signing key/u,
  );
});

test("the origin is the stage's own: https, carrying its stage label, never production's zone", async () => {
  const refusals: [string, RegExp][] = [
    // Each spelling names production's host.
    [`https://${brand.host}./`, /production's host/u],
    [`https://${brand.host.toUpperCase()}`, /production's host/u],
    [`https://${brand.host.toUpperCase()}.`, /production's host/u],
    // Under production's zone only the stage's own app host is admitted; the rest is production.
    [`https://rehearsal-3.${brand.host}`, /production's host/u],
    [`https://${brand.zone}`, /production's host/u],
    [`https://www.${brand.zone}`, /production's host/u],
    [`https://rehearsal-3.${brand.zone}`, /production's host/u],
    [`https://x.app.rehearsal-3.${brand.zone}`, /production's host/u],
    [`https://api.rehearsal-3.${brand.zone}`, /production's host/u],
    [`https://app.rehearsal-4.${brand.zone}`, /production's host/u],
    [`https://app.rehearsal-30.${brand.zone}`, /production's host/u],
    [`https://a-00000000-0000-4000-8000-000000000000.${brand.zone}`, /production's host/u],
    // Two trailing dots, or any empty label, name no host at all.
    [`https://app.rehearsal-3.${brand.zone}..`, /empty label/u],
    [`https://${brand.host}..`, /empty label/u],
    // A host that is not this stage's.
    ["https://app.rehearsal-4.stage.example", /stage's label/u],
    ["https://app.stage.example", /stage's label/u],
    ["https://app.xrehearsal-3.stage.example", /stage's label/u],
    ["https://app.rehearsal-30.stage.example", /stage's label/u],
    ["http://app.rehearsal-3.stage.example", /https origin/u],
    ["app.rehearsal-3.stage.example", /https origin/u],
  ];
  for (const [origin, why] of refusals)
    await assert.rejects(
      registerRehearsalAcceptanceDevice({ ...input, origin }, untouched),
      why,
      origin,
    );
  // The stage's own host, in any spelling of it, is sent to as one.
  for (const origin of [input.origin, "https://APP.Rehearsal-3.stage.example./"]) {
    let sent: string | undefined;
    await registerRehearsalAcceptanceDevice({ ...input, origin }, async (url) => {
      sent = String(url);
      return new Response(null, { status: 403 });
    }).catch(() => {});
    assert.equal(sent, `https://app.rehearsal-3.stage.example${nativeControlPath}`, origin);
  }
  // A rehearsal stage in production's zone: its own app host, in any spelling, is admitted.
  for (const origin of [
    `https://app.rehearsal-3.${brand.zone}`,
    `https://APP.Rehearsal-3.${brand.zone.toUpperCase()}./`,
  ]) {
    let sent: string | undefined;
    await registerRehearsalAcceptanceDevice({ ...input, origin }, async (url) => {
      sent = String(url);
      return new Response(null, { status: 403 });
    }).catch(() => {});
    assert.equal(sent, `https://app.rehearsal-3.${brand.zone}${nativeControlPath}`, origin);
  }
});

test("the stage pool's own registration makes a models-only device the release then signs for", async () => {
  const f = fixture();
  const device = await registerRehearsalAcceptanceDevice(
    input,
    async (url, init) => f.nativeControl(new Request(url, init)),
    f.now,
  );
  assert.deepEqual(Object.keys(device).sort(), ["computer", "grant", "pool", "user"]);
  assert.equal(device.user, owner);
  assert.equal(device.pool, pool.pool);
  assert.match(device.grant, /^native:/u);
  const row = (await f.registry())[device.computer];
  assert.equal(row?.state, "active");
  assert.deepEqual(
    { models: row?.native?.models, tools: row?.native?.toolsOrganization },
    { models: true, tools: undefined },
  );
  const credential = acceptanceCredential(
    { POOL_ACCEPTANCE_DEVICE: JSON.stringify(device), POOL_APP_SIGNING_KEY: signingKey },
    f.now,
  );
  const admitted = await f.nativeModel(
    new Request("https://pool.example/v1/models", {
      headers: await credential("GET", "/v1/models"),
    }),
  );
  admitted.release();
  assert.equal(
    admitted.request.headers.get("authorization"),
    `Bearer ${f.server.keys[0]!.api_key}`,
  );
});
