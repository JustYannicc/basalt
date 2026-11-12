import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { decodeSelectedAccountView } from "apps";
import type { SelectedAccountView } from "apps/contracts";
import type { Account, PoolView } from "./contract.ts";
import { providerAccountView } from "./provider-account-view.ts";
import { nativeAccountView } from "../../src/pool/native-account-view.ts";
import type { NativeMembershipSnapshot } from "../../src/pool/membership-contract.ts";

const native = "acc_shared";
const source = "app_source";
const icon = (label: string) => `data:image/svg+xml;base64,${btoa(`<svg id="${label}"/>`)}`;
const view = (): PoolView => ({
  isOwner: true,
  providers: [{ id: "codex", name: "ChatGPT" }],
  subscriptionAccountIds: ["backend-row"],
  accounts: [
    {
      id: "backend-row",
      nativeAccountId: native,
      provider: "codex",
      label: "old-private-label",
      plan: "promax",
      state: "disabled",
      message: "Paused by owner",
      windows: [
        {
          id: "old",
          label: "Old weekly",
          remainingRatio: 0.9,
          resetAt: null,
          windowSeconds: 604_800,
          observedAt: "2026-11-12T10:00:00Z",
        },
      ],
      observedAt: "2026-11-12T10:00:00Z",
      freshness: "fresh",
      readingFailed: false,
      nextReadAt: null,
      earliestResetAt: null,
      bankedResets: { available: 99, nextExpiresAt: null },
    },
  ],
});
const available = (sourceApp = source, icons = [{ src: icon("first") }]) =>
  decodeSelectedAccountView({
    state: "available",
    account: { id: native, label: "Native label", method: "codex" },
    sourceApp: { id: sourceApp, version: "version-one", name: "Native provider", icons },
    health: { account: native, info: null, infoCheckedAt: null, apps: [] },
    canInspect: true,
    observations: {
      account: native,
      reports: [
        {
          source: { kind: "driver", id: "fixture", version: "one", label: "Native reading" },
          credentialGeneration: 2,
          checkedAt: "2026-11-12T11:00:00Z",
          lastAttempt: null,
          freshness: "fresh",
          collecting: false,
          nextAllowedAt: null,
          result: {
            observedAt: "2026-11-12T11:00:00Z",
            observation: {
              offering: "subscription",
              plan: { label: "Native plan", observedAt: "2026-11-12T11:00:00Z" },
              windows: [
                {
                  id: "model-week",
                  label: "Native model week",
                  scope: { kind: "model", id: "model-one" },
                  observedAt: "2026-11-12T11:00:00Z",
                  measure: { unit: "requests", remainingRatio: 0.98 },
                  period: { seconds: 604_800 },
                  resetsAt: "2026-11-19T11:00:00Z",
                },
              ],
              balances: [],
            },
          },
        },
      ],
    },
  });
const binding = (resolved = true) =>
  decodeSelectedAccountView({
    ...available("app_pool"),
    ...(resolved
      ? { sourceConnection: { connection: "accountView", target: source, account: native } }
      : {}),
  });
const json = Schema.decodeUnknownSync(Schema.Json);
const context = (
  read: () => Promise<SelectedAccountView>,
  call: Parameters<typeof providerAccountView>[0]["apps"]["call"],
) => ({
  app: { accounts: { openai: [{ id: available().account.id, read }] } },
  apps: { call },
});
const membership = (
  accounts: readonly { account: string; homeReference: string }[],
): NativeMembershipSnapshot => ({
  pool: "app_pool",
  organization: "fixture",
  native: true,
  accounts: accounts.map((account) => ({
    ...account,
    requirement: "openai",
    provider: "provider",
    method: "codex",
    generation: 2,
    driver: "fixture",
    driverRevision: "one",
    bindingRevision: "one",
  })),
});
const routing = (accounts: readonly Account[]) =>
  accounts.map(({ id, provider, state, message }) => ({ id, provider, state, message }));

test("native identity annotations preserve every pool member and routing state", () => {
  const before = view();
  const exact = nativeAccountView(
    before,
    membership([{ account: native, homeReference: "backend-row" }]),
  );
  assert.equal(exact.accounts[0]?.nativeAccountId, native);
  const ambiguous = nativeAccountView(
    before,
    membership([
      { account: native, homeReference: "backend-row" },
      { account: "acc_other", homeReference: "backend-row" },
    ]),
  );
  assert.equal(ambiguous.accounts[0]?.nativeAccountId, null);
  const unavailable = nativeAccountView(before, undefined);
  assert.equal(unavailable.accounts[0]?.nativeAccountId, null);
  for (const candidate of [exact, ambiguous, unavailable]) {
    assert.deepEqual(routing(candidate.accounts), routing(before.accounts));
    assert.deepEqual(candidate.subscriptionAccountIds, before.subscriptionAccountIds);
  }
});

test("the pool invokes the exact saved provider source and preserves its native reading", async () => {
  const before = view(),
    latest = available();
  const calls: unknown[] = [];
  const ctx = context(
    async () => binding(),
    async (input) => {
      calls.push(input);
      return json(latest);
    },
  );
  const after = await providerAccountView(ctx, before);
  assert.deepEqual(calls, [
    {
      connection: "accountView",
      target: source,
      tool: "accountView",
      kind: "query",
      input: { account: native },
    },
  ]);
  assert.deepEqual(after.accounts[0]?.nativeView, latest);
  assert.equal(after.accounts[0]?.label, "Native label");
  assert.equal(after.providers[0]?.name, "Native provider");
  assert.equal(after.providers[0]?.icons?.[0]?.src, icon("first"));
  assert.deepEqual(routing(after.accounts), routing(before.accounts));
  assert.deepEqual(after.subscriptionAccountIds, before.subscriptionAccountIds);
  const changed = available(source, [{ src: icon("changed") }]);
  const next = await providerAccountView(
    context(
      async () => binding(),
      async () => json(changed),
    ),
    before,
  );
  assert.equal(next.providers[0]?.icons?.[0]?.src, icon("changed"));
});

test("ambiguous source selection keeps today's presentation and never guesses a target", async () => {
  const before = view();
  const after = await providerAccountView(
    context(
      async () => binding(false),
      async () => {
        throw new Error("must not call");
      },
    ),
    before,
  );
  assert.deepEqual(after, before);
});

test("denied inspection and stale source replies cannot leak the pool's copied identity or allowance", async () => {
  const before = view();
  const denied = decodeSelectedAccountView({ state: "denied", account: { id: native } });
  const contexts = [
    context(
      async () => denied,
      async () => {
        throw new Error("must not call");
      },
    ),
    context(
      async () => binding(),
      async () => json(available("app_replaced")),
    ),
    context(
      async () => binding(),
      async () => {
        throw new Error("revoked");
      },
    ),
    context(
      async () =>
        decodeSelectedAccountView({ ...binding(false), canInspect: false, observations: null }),
      async () => {
        throw new Error("must not call");
      },
    ),
  ];
  for (const ctx of contexts) {
    const after = await providerAccountView(ctx, before),
      account = after.accounts[0]!;
    assert.equal(account.plan, null);
    assert.deepEqual(account.windows, []);
    assert.equal(account.bankedResets, null);
    assert.equal(account.observedAt, null);
    assert.equal(account.label.includes("old-private"), false);
    assert.deepEqual(routing(after.accounts), routing(before.accounts));
    assert.deepEqual(after.subscriptionAccountIds, before.subscriptionAccountIds);
  }
});
