import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect, Option, Redacted } from "effect";
import { providerDeclaration } from "../../.upstream/packages/apps/src/host.ts";
import { AccountId, OwnerId, identifyProvider } from "../../.upstream/packages/sdk/src/core.ts";
import { makeAcquisitionRegistry } from "../../.upstream/packages/sdk/src/implementation/account-acquisition-registry.ts";
import { poolAccountAcquisition } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-acquisition.ts";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";
import { providerCapabilities } from "../../src/pool/provider-accounts/capabilities.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { handleAccountKeyMirror } from "../../src/pool/account-key-mirror.ts";

const signingKey = "ab".repeat(32);
const reference = "12345678-abcd-4000-8000-000000000001";
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
const registrations = () => Effect.runPromise(poolAccountAcquisition(
  Option.some(Redacted.make(signingKey)), "https://pool.example",
).pipe(Effect.provideService(Crypto.Crypto, crypto)));
const jevIdentity = () => Effect.runPromise(providerDeclaration(providers.jev).pipe(
  Effect.flatMap((definition) => identifyProvider(definition, crypto)),
));

test("the trusted registry resolves canonical and retained Jev keys without offering unsupported methods", async () => {
  const options = await registrations();
  const registry = await Effect.runPromise(makeAcquisitionRegistry(options.registrations));
  const jev = await jevIdentity();
  for (const id of new Set([jev.identity, jev.legacy])) {
    const registration = registry.current(id, "apiKey");
    assert.ok(registration);
    assert.equal(registration.current, true);
    assert.equal(registration.exposeHostReference, true);
    assert.equal(registration.driver.id, "basalt-home");
    assert.equal(registration.driver.revision, "key-mirror-v1");
    assert.ok(registration.driver.mirror);
  }
  for (const capability of providerCapabilities.filter((item) => item.connection === "unavailable")) {
    const definition = await Effect.runPromise(providerDeclaration(providers[capability.lab]));
    const identity = await Effect.runPromise(identifyProvider(definition, crypto));
    assert.equal(registry.current(identity.identity, capability.method), undefined);
  }
  assert.deepEqual(jev.definition.auth.apiKey, {
    type: "secrets", label: "TypeSafe API key",
    fields: { type: "object", properties: { token: { type: "string", minLength: 1 } }, required: ["token"], additionalProperties: true, $defs: {}, $schema: "https://json-schema.org/draft/2020-12/schema" },
  });
  assert.equal(providerCapabilities.find((item) => item.lab === "jev")?.protocol, "typesafe-systemone");
});

test("Jev's registered Promise adapter mirrors its original token through the signed Home endpoint", async () => {
  const options = await registrations();
  const identity = await jevIdentity();
  const registration = options.registrations.find((entry) => entry.provider === identity.identity && entry.method === "apiKey");
  assert.ok(registration?.driver.mirror);
  const homeCalls: { path: string; method: string; body: unknown }[] = [];
  const home = new HomeClient(async (path, init) => {
    const body: unknown = init?.body === undefined ? null : JSON.parse(String(init.body));
    homeCalls.push({ path, method: init?.method ?? "GET", body });
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ name: `${reference}.json` });
  });
  let unavailable = true;
  const requestFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://pool.example/pool/v1/account-mirrors");
    if (unavailable) return new Response(null, { status: 503 });
    return handleAccountKeyMirror(request, { home, signingKey });
  };
  const fields = { token: "synthetic-existing-tool-token" };
  const context = {
    owner: OwnerId.make("organization:fixture"), provider: identity.identity, method: "apiKey",
    operation: "fixture-mirror", deadline: Date.now() + 30_000,
    signal: new AbortController().signal, fetch: requestFetch,
    binding: {
      account: AccountId.make("acc_fixture"), owner: OwnerId.make("organization:fixture"),
      provider: identity.identity, method: "apiKey", driver: "basalt-home", driverRevision: "key-mirror-v1",
      generation: 1, revision: "fixture-r1", removal: null,
    },
    reference: Redacted.make(reference), fields: Redacted.make(fields),
  };
  await assert.rejects(Effect.runPromise(registration.driver.mirror(context)), /Account mirror backend unavailable/);
  assert.equal(homeCalls.length, 0);
  unavailable = false;
  await Effect.runPromise(registration.driver.mirror(context));
  await Effect.runPromise(registration.driver.mirror(context));
  assert.deepEqual(homeCalls.map((call) => call.body), [
    { type: "typesafe", token: fields.token, uuid: reference },
    { type: "typesafe", token: fields.token, uuid: reference },
  ]);
  assert.deepEqual(fields, { token: "synthetic-existing-tool-token" });
  await Effect.runPromise(registration.driver.remove(context));
  assert.equal(homeCalls.at(-1)?.path, `/v8/management/credentials?id=${reference}`);
  assert.equal(homeCalls.some((call) => call.path.includes("channel-group")), false);
});

test("a host without a signing key registers no acquisition or mirror driver", async () => {
  assert.deepEqual(await Effect.runPromise(poolAccountAcquisition(Option.none(), "https://pool.example").pipe(Effect.provideService(Crypto.Crypto, crypto))), { registrations: [] });
});
