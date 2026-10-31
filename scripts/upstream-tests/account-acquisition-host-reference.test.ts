import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);

test("only an explicitly enabled acquisition registration exposes its opaque host reference", async () => {
  const [sdk, runtime] = await Promise.all([
    load("packages/sdk/src/core.ts"),
    load("packages/sdk/src/implementation/account-acquisition-runtime.ts"),
  ]);
  const account = "acc_host-reference";
  const owner = "organization:org_host-reference";
  const provider = "prv_host-reference";
  const binding = {
    account,
    owner,
    provider,
    method: "apiKey",
    driver: "product-driver",
    driverRevision: "r1",
    generation: 3,
    revision: "binding-r3",
    removal: null,
    mirrorReference: null,
    mirrorReady: true,
    mirrorOperation: null,
  };
  const stored = {
    id: account,
    owner,
    provider,
    method: "apiKey",
    label: "Fixture",
    description: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    site: null,
    encryptedCredentials: new Uint8Array([1]),
    credentialGeneration: 3,
    allowedHosts: null,
    identityId: null,
    oauthGrantId: null,
  };
  assert.doesNotThrow(() => Schema.decodeUnknownSync(sdk.StoredAccount)(stored));
  const db = {
    findFirst: (table: string) =>
      Effect.succeed(
        table === "accounts" ? stored : table === "accountAcquisitions" ? binding : null,
      ),
    updateMany: () => Effect.succeed({ count: 1 }),
  };
  const credentials = {
    decrypt: () => Effect.succeed(Redacted.make({ ref: "opaque-home-reference" })),
  };
  const driver = {
    id: "product-driver",
    revision: "r1",
    start: () => Effect.void,
    status: () => Effect.void,
    cancel: () => Effect.void,
    remove: () => Effect.void,
  };
  const registration = {
    provider,
    method: "apiKey",
    current: true,
    driver,
    fetch,
  };
  const source = (exposeHostReference: boolean): Effect.Effect<{
    hostReference?: Redacted.Redacted<string>;
  }, unknown> => {
    const registry = {
      retained: () =>
        Effect.succeed({
          ...registration,
          ...(exposeHostReference ? { exposeHostReference: true } : {}),
        }),
    };
    return runtime.makeAcquisitionRuntime(db, credentials, {}, registry).source({
      account: Schema.decodeUnknownSync(sdk.AccountId)(account),
      owner: Schema.decodeUnknownSync(sdk.OwnerId)(owner),
    }) as Effect.Effect<{ hostReference?: Redacted.Redacted<string> }, unknown>;
  };

  const allowed = await Effect.runPromise(source(true));
  assert.ok(allowed.hostReference);
  assert.equal(Redacted.value(allowed.hostReference), "opaque-home-reference");
  const defaulted = await Effect.runPromise(source(false));
  assert.equal(defaulted.hostReference, undefined);
});
