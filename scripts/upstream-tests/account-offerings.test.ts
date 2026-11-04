import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Crypto, Effect, Schema } from "effect";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
import {
  AccountFamily,
  AccountOffering,
  declaredAccountOffering,
} from "../../.upstream/packages/apps/src/contracts/host.ts";
import { providerDeclaration } from "../../.upstream/packages/apps/src/host.ts";
import {
  type ProviderDefinition,
  identifyProvider,
} from "../../.upstream/packages/sdk/src/core.ts";
const { planAccountConsumerMethod } = await load("packages/sdk/src/contracts/account-consumers.ts");
const { accountOffering, accountKindLabel, accountMethodKindLabel } = await load(
  "packages/ui/src/contracts/account-identities.ts",
);
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});

test("offering hints are optional, validated and independent of credential mechanism", () => {
  const decode = Schema.decodeUnknownSync(AccountFamily);
  assert.deepEqual(
    decode({
      id: "service",
      name: "Service",
      methods: {
        oauth: { mechanism: "oauth", offering: "metered_api" },
        key: { mechanism: "api-key", offering: "subscription" },
        other: { mechanism: "interactive" },
      },
    }),
    {
      id: "service",
      name: "Service",
      methods: {
        oauth: { mechanism: "oauth", offering: "metered_api" },
        key: { mechanism: "api-key", offering: "subscription" },
        other: { mechanism: "interactive" },
      },
    },
  );
  assert.throws(() => Schema.decodeUnknownSync(AccountOffering)("api-key"));
  assert.throws(() =>
    decode({
      id: "service",
      name: "Service",
      methods: {
        key: { mechanism: "api-key", offering: "unlimited" },
      },
    }),
  );
});

test("adding or changing offering hints preserves every canonical and legacy provider ID", async () => {
  for (const provider of Object.values(providers)) {
    const definition = await Effect.runPromise(providerDeclaration(provider));
    const identified = await Effect.runPromise(identifyProvider(definition, crypto));
    const family = definition.family;
    assert.ok(family?.methods);
    for (const offering of [undefined, "prepaid", "subscription", "unknown"] as const) {
      const variant: ProviderDefinition = {
        ...definition,
        family: {
          ...family,
          methods: Object.fromEntries(
            Object.entries(family.methods).map(([name, method]) => {
              const { offering: _offering, ...connection } = method;
              return [name, { ...connection, ...(offering === undefined ? {} : { offering }) }];
            }),
          ),
        },
      };
      const changed = await Effect.runPromise(identifyProvider(variant, crypto));
      assert.equal(changed.identity, identified.identity);
      assert.equal(changed.legacy, identified.legacy);
    }
  }
});

const definition = (offering?: string) => ({
  name: "Service",
  family: {
    id: "service",
    name: "Service",
    methods: {
      oauth: { mechanism: "oauth", ...(offering === undefined ? {} : { offering }) },
      apiKey: { mechanism: "api-key" },
    },
  },
  auth: {
    oauth: { type: "interactive", label: "Sign in" },
    apiKey: { type: "secrets", label: "API key", fields: { type: "object" } },
  },
});
const account = { provider: "prv_fixture", method: "oauth" };
const inventory = (...definitions: object[]) => ({
  apps: definitions.map((definition) => ({
    requirements: { accounts: { service: { provider: "prv_fixture", definition } } },
  })),
});

test("unknown and contradictory declarations stay unknown and never imply subscription", () => {
  assert.equal(accountOffering(inventory(definition()), account), "unknown");
  assert.equal(accountKindLabel(inventory(definition()), account), undefined);
  const family = Schema.decodeUnknownSync(AccountFamily);
  assert.equal(declaredAccountOffering([], "oauth"), undefined);
  assert.equal(
    declaredAccountOffering([family(definition("subscription").family)], "oauth"),
    "subscription",
  );
  assert.equal(
    declaredAccountOffering(
      [family(definition("subscription").family), family(definition("prepaid").family)],
      "oauth",
    ),
    undefined,
  );
  assert.equal(accountMethodKindLabel(definition(), "oauth"), undefined);
  assert.equal(accountMethodKindLabel(definition("subscription"), "oauth"), "Subscription");

  assert.equal(accountOffering(inventory(definition("subscription")), account), "subscription");
  assert.equal(accountKindLabel(inventory(definition("subscription")), account), "Subscription");
  assert.equal(
    accountOffering(inventory(definition("subscription"), definition("prepaid")), account),
    "unknown",
  );
  assert.equal(
    accountKindLabel(inventory(definition()), { ...account, method: "apiKey" }),
    "API key",
  );
  assert.equal(
    accountOffering(inventory(definition()), { ...account, method: "apiKey" }),
    "unknown",
  );
});

test("offering hints do not change the capability planner's availability or requested access", () => {
  const plan = (offering?: string) =>
    planAccountConsumerMethod(
      {
        provider: "prv_fixture",
        definition: definition(offering),
        capabilities: ["model-inference"],
        hostAcquisition: ["oauth"],
      },
      "oauth",
      [],
    );
  const unknown = plan();
  assert.equal(unknown.status, "unavailable");
  assert.deepEqual(plan("subscription"), unknown);
});
