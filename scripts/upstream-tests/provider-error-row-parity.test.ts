import assert from "node:assert/strict";
import { test } from "node:test";

const { appProviderFailure } = (await import(
  new URL("../../.upstream/packages/sdk/src/implementation/provider-error.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/provider-error.ts");
const { accountKindLabel, accountTitle } = (await import(
  new URL("../../.upstream/packages/ui/src/contracts/account-identities.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/ui/src/contracts/account-identities.ts");
const { ProviderError } = (await import(
  new URL("../../.upstream/packages/apps/src/contracts/provider-error.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/apps/src/contracts/provider-error.ts");
const { AccountId, ProviderId, OwnerId } = (await import(
  new URL("../../.upstream/packages/sdk/src/contracts/shared.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/shared.ts");

const Effect = (await import(
  new URL("../../.upstream/node_modules/effect/dist/Effect.js", import.meta.url).href
)) as typeof import("../../.upstream/node_modules/effect/dist/Effect.js");
const db = { findMany: () => Effect.succeed([]) } as unknown as Parameters<
  typeof appProviderFailure
>[0]["db"];

type Definition = Parameters<
  typeof accountKindLabel
>[0]["apps"][number]["requirements"]["accounts"][string]["definition"];
const legacy = "prv_2b75c3056562dbf5eeb5d1a37f9d5de7fb28a0dd83a6c76ffe7ea2e2d4a8605c";

for (const [name, provider, method, definition, expected] of [
  [
    "mechanism other",
    "prv_other",
    "apiKey",
    {
      name: "Example",
      auth: { apiKey: { type: "secrets", label: "API key" } },
      family: { id: "example", name: "Example", methods: { apiKey: { mechanism: "other" } } },
    },
    "Example account 2",
  ],
  [
    "legacy access token",
    legacy,
    "apiKey",
    {
      name: "Vercel",
      auth: { apiKey: { type: "secrets", label: "Access token" } },
    },
    "Vercel API key 2",
  ],
  [
    "OAuth without a label",
    "prv_oauth",
    "oauth",
    {
      name: "X",
      auth: { oauth: { type: "oauth2" } },
    },
    "X OAuth 2",
  ],
] as const) {
  test(`provider error equals the Accounts-row title for ${name}`, async () => {
    const account = {
      id: AccountId.make("acc_example"),
      label: "Default 2",
      method,
      provider: ProviderId.make(provider),
      providerName: definition.name,
      owner: OwnerId.make("owner_example"),
      identityId: null,
      description: null,
      createdAt: new Date(0),
    } as Parameters<typeof accountKindLabel>[1];
    const required = { provider, definition: definition as unknown as Definition };
    const inventory = {
      apps: [{ requirements: { accounts: { service: required } } }],
    } as unknown as Parameters<typeof accountKindLabel>[0];
    const rowTitle = accountTitle(account, undefined, accountKindLabel(inventory, account));
    assert.equal(rowTitle, expected);
    const state = {
      app: { id: "app_example" },
      version: { id: "dpl_example" },
      selections: [{ required, accounts: [account] }],
    } as unknown as Parameters<ReturnType<typeof appProviderFailure>>[0];
    const error = await Effect.runPromise(
      Effect.flip(
        appProviderFailure({
          db,
          lifecycle: undefined,
          readHealth: () => Effect.succeed({ info: null }),
        })(state, new ProviderError({ reason: "forbidden", status: 403, accountId: account.id })),
      ),
    );
    assert.ok(error._tag === "AppProviderFailed");
    assert.equal(error.account?.label, rowTitle);
    assert.ok(error.description.includes(`for account “${rowTitle}”`));
  });
}
