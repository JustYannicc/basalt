import assert from "node:assert/strict";
import { test } from "node:test";

const { appProviderFailure } = (await import(
  new URL("../../.upstream/packages/sdk/src/implementation/provider-error.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/provider-error.ts");

const { ProviderError } = (await import(
  new URL("../../.upstream/packages/apps/src/contracts/provider-error.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/apps/src/contracts/provider-error.ts");

const { accountProblems } = (await import(
  new URL("../../.upstream/packages/sdk/src/contracts/account.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/account.ts");
const { StorageError, AccountId } = (await import(
  new URL("../../.upstream/packages/sdk/src/contracts/shared.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/contracts/shared.ts");
const { diagnostic, diagnosticSummary } = (await import(
  new URL("../../.upstream/packages/mcp/src/implementation/diagnostics.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/mcp/src/implementation/diagnostics.ts");
const { describeAppFailure, renderAppFailure } = (await import(
  new URL("../../.upstream/packages/app-management/src/cli.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/app-management/src/cli.ts");

const state = (label: string, identity?: { label: string }, method = "apiKey") =>
  ({
    app: { id: "app_example" },
    version: { id: "dpl_example" },
    selections: [
      {
        required: {
          definition: {
            name: "Vercel",
            auth: {
              apiKey: { type: "secrets", label: "API key" },
            },
          },
        },
        accounts: [{ id: "acc_example", label, method, ...(identity ? { identity } : {}) }],
      },
    ],
  }) as unknown as Parameters<typeof appProviderFailure>[0];

const failure = (label: string, accountId = AccountId.make("acc_example")) =>
  appProviderFailure(
    state(label),
    new ProviderError({ reason: "rejected", status: 403, accountId }),
  );

for (const [label, title] of [
  ["Default", "Vercel API key"],
  ["Default 2", "Vercel API key 2"],
  ["  ", "Vercel API key"],
  ["Production", "Production"],
  ["Default account", "Default account"],
])
  test(`provider errors name ${JSON.stringify(label)} as ${JSON.stringify(title)}`, () => {
    const error = failure(label);
    assert.equal(error.account?.label, title);
    assert.ok(error.description.startsWith(`Vercel refused the request for account “${title}”`));
  });

test("a verified identity precedes an authored label", () => {
  const error = appProviderFailure(
    state("Work", { label: "verified@example.test" }),
    new ProviderError({
      reason: "unauthorized",
      status: 401,
      accountId: AccountId.make("acc_example"),
    }),
  );
  assert.equal(error.account?.label, "verified@example.test");
});

test("an unknown method falls back to provider account and keeps the number", () => {
  const error = appProviderFailure(
    state("Default 2", undefined, "missing"),
    new ProviderError({
      reason: "unauthorized",
      status: 401,
      accountId: AccountId.make("acc_example"),
    }),
  );
  assert.equal(error.account?.label, "Vercel account 2");
});

test("every provider refusal that names an account uses its row title", () => {
  for (const reason of ["unauthorized", "forbidden", "rate_limited", "rejected"] as const) {
    const error = appProviderFailure(
      state("Default 2"),
      new ProviderError({
        reason,
        status: 403,
        accountId: AccountId.make("acc_example"),
      }),
    );
    assert.ok(error.description.includes("for account “Vercel API key 2”"));
  }
  const renewed = appProviderFailure(
    state("Default"),
    new ProviderError({
      reason: "unauthorized",
      status: 401,
      accountId: AccountId.make("acc_example"),
    }),
    "renewed",
  );
  assert.ok(renewed.description.includes("for account “Vercel API key”"));
  const renewalFailed = appProviderFailure(
    state("Default 2"),
    new ProviderError({
      reason: "unauthorized",
      status: 401,
      accountId: AccountId.make("acc_example"),
    }),
    new StorageError(),
  );
  assert.ok(renewalFailed.description.includes("for account “Vercel API key 2”"));
});

test("a server error still names no account in its copy", () => {
  const error = appProviderFailure(
    state("Default"),
    new ProviderError({
      reason: "unavailable",
      status: 503,
      accountId: AccountId.make("acc_example"),
    }),
  );
  assert.equal(error.account?.label, "Vercel API key");
  assert.equal(error.description, "Vercel returned a server error (HTTP 503).");
});

test("MCP diagnostics and CLI text retain the account's row title", () => {
  const error = failure("Default 2");
  assert.ok(JSON.parse(diagnostic(error)).message.includes("for account “Vercel API key 2”"));
  assert.ok(diagnosticSummary(error).includes("for account “Vercel API key 2”"));
  const described = describeAppFailure(error);
  assert.ok(described);
  assert.ok(renderAppFailure(described).includes("for account “Vercel API key 2”"));
});

test("app page provider failures use the row title, including reported identity", () => {
  const app = {
    id: "app_example",
    requirements: {
      accounts: {
        service: {
          scope: "user",
          cardinality: "one",
          provider: "prv_example",
          definition: state("Default").selections[0]!.required.definition,
        },
      },
    },
  } as unknown as Parameters<typeof accountProblems>[0];
  const chosen = { app: {}, user: { service: [AccountId.make("acc_example")] } };
  for (const [label, info, identity, title] of [
    ["Default", null, undefined, "Vercel API key"],
    ["Default 2", null, undefined, "Vercel API key 2"],
    ["  ", null, undefined, "Vercel API key"],
    ["Production", null, undefined, "Production"],
    ["Default", { email: "reported@example.test" }, undefined, "reported@example.test"],
    ["Production", null, { label: "verified@example.test" }, "verified@example.test"],
  ] as const) {
    const found = new Map([
      [
        "acc_example",
        {
          account: {
            id: "acc_example",
            provider: "prv_example",
            method: "apiKey",
            label,
            identity,
          },
          health: {
            info,
            apps: [
              { app: "app_example", check: { current: true, status: "credentials_rejected" } },
            ],
          },
        },
      ],
    ]) as unknown as Parameters<typeof accountProblems>[2];
    assert.deepEqual(accountProblems(app, chosen, found), [
      { provider: "Vercel", account: title, reason: "credentials_rejected" },
    ]);
  }
});

test("a failure without an attributable account keeps its message", () => {
  const error = failure("Default", AccountId.make("acc_unselected"));
  assert.equal(error.account, undefined);
  assert.equal(
    error.description,
    "The connected service refused the request (HTTP 403). We could not identify the cause from the available error details.",
  );
});
