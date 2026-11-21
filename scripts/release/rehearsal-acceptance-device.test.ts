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
    // Anything under production's zone is production, whatever it names.
    [`https://rehearsal-3.${brand.host}`, /production's host/u],
    [`https://app.rehearsal-3.${brand.zone}.`, /production's host/u],
    [`https://${brand.zone}`, /production's host/u],
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
});

test("a resolver drops every trailing dot, so production's zone with several is still production's", async () => {
  // URL decodes percent escapes and maps the ideographic and full-width stops to dots first.
  for (const tail of ["..", "...", ".%2E", "%2E%2E", ".。", "．｡"])
    await assert.rejects(
      registerRehearsalAcceptanceDevice(
        { ...input, origin: `https://rehearsal-3.${brand.zone}${tail}` },
        untouched,
      ),
      /production's host/u,
      JSON.stringify(tail),
    );
  // No resolver names a host with an empty label, so none is sent to.
  for (const origin of [
    "https://app..rehearsal-3.stage.example",
    "https://app.rehearsal-3..stage.example",
  ])
    await assert.rejects(
      registerRehearsalAcceptanceDevice({ ...input, origin }, untouched),
      /empty label/u,
      origin,
    );
  for (const origin of [
    "https://app.rehearsal-3.stage.example..",
    "https://app.rehearsal-3.stage.example.。/",
  ]) {
    let sent: string | undefined;
    await registerRehearsalAcceptanceDevice({ ...input, origin }, async (url) => {
      sent = String(url);
      return new Response(null, { status: 403 });
    }).catch(() => {});
    assert.equal(sent, `https://app.rehearsal-3.stage.example${nativeControlPath}`, origin);
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
