import assert from "node:assert/strict";
import { test } from "node:test";
import rows from "./fixtures/account-kind-rows.json" with { type: "json" };
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const { accountKindLabel, accountMethodKindLabel, connectionKindLabel } = await load("packages/ui/src/contracts/account-identities.ts");

// Declaration-only shapes from the authorized 21-row inventory. No saved identity or credentials.
const inventory = (provider: string, ...definitions: object[]) => ({
  apps: definitions.map((definition) => ({
    requirements: { accounts: { service: { provider, definition } } },
  })),
});

test("all 21 retained account row shapes resolve their declared connection kind", () => {
  assert.equal(rows.length, 21);
  const before = JSON.stringify(rows);
  const actual = rows.map(({ provider, method, definition }) =>
    accountKindLabel(inventory(provider, definition), { provider, method }),
  );
  assert.deepEqual(actual, rows.map((row) => row.expected));
  for (const row of rows)
    assert.equal(accountMethodKindLabel(row.definition, row.method, row.provider), row.expected);
  assert.equal(JSON.stringify(rows), before, "display resolution must not mutate input");
});

test("OAuth and funding are separate labels, including methods without family metadata", () => {
  assert.equal(connectionKindLabel("oauth", undefined), "OAuth");
  assert.equal(connectionKindLabel("oauth", "metered_api"), "OAuth · Metered API");
  assert.equal(connectionKindLabel("api-key", "subscription"), "API key · Subscription");
  assert.equal(accountMethodKindLabel({ auth: { signIn: { type: "oauth2" } } }, "signIn"), "OAuth");
});

test("legacy display hints require an exact provider and method; declarations take precedence", () => {
  const row = rows.find((row) => row.method === "codex")!;
  const unknown = { provider: "prv_unknown", method: "codex" };
  assert.equal(accountKindLabel(inventory(unknown.provider, row.definition), unknown), undefined);
  assert.equal(accountKindLabel(inventory(row.provider, row.definition), { ...unknown, provider: row.provider, method: "different" }), undefined);
  const declared = (offering: string, mechanism = "interactive") => ({
    ...row.definition,
    family: { id: "test", name: "Test", methods: { codex: { mechanism, offering } } },
  });
  const account = { provider: row.provider, method: row.method };
  assert.equal(accountKindLabel(inventory(row.provider, declared("prepaid")), account), "Prepaid");
  assert.equal(accountKindLabel(inventory(row.provider, declared("unknown")), account), undefined);
  assert.equal(accountKindLabel(inventory(row.provider, declared("subscription"), declared("prepaid")), account), undefined);
  assert.equal(accountKindLabel(inventory(row.provider, declared("unknown", "oauth"), declared("unknown", "api-key")), account), undefined);
  const mechanismOnly = (mechanism: string) => ({ ...row.definition,
    family: { id: "test", name: "Test", methods: { codex: { mechanism } } },
  });
  assert.equal(accountKindLabel(inventory(row.provider, mechanismOnly("oauth"), mechanismOnly("api-key")), account), undefined);
  assert.equal(accountKindLabel(inventory("prv_unknown", { auth: { apiKey: { type: "secrets" } } }), { provider: "prv_unknown", method: "apiKey" }), undefined);
});

test("verified legacy declarations still identify as the exact compatibility provider IDs", async () => {
  const { createHash } = await import("node:crypto");
  const { Crypto, Effect, Schema } = await import("effect");
  const { identifyProvider } = await import("../../.upstream/packages/sdk/src/implementation/provider.ts");
  const { ProviderDefinition } = await import("../../.upstream/packages/sdk/src/contracts/provider.ts");
  const { default: declarations } = await import("./fixtures/legacy-kind-providers.json", { with: { type: "json" } });
  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
  });
  assert.equal(declarations.length, 4);
  for (const row of declarations) {
    const ids = await Effect.runPromise(identifyProvider(Schema.decodeUnknownSync(ProviderDefinition)(row.definition), crypto));
    assert.ok([ids.identity, ids.legacy].some((id) => id === row.provider), row.definition.name);
  }
});
