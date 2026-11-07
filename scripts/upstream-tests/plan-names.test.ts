import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { Account } from "../../.upstream/packages/sdk/src/contracts/account.ts";
import { App } from "../../.upstream/packages/sdk/src/contracts/apps.ts";
import { accountFamily } from "../../.upstream/packages/ui/src/contracts/account-identities.ts";
import { planLabel } from "../../.upstream/packages/ui/src/implementation/dashboard/account-observation-format.ts";
import { planName, candidateName, exclusionName } from "../../apps/pool/ui/capacity-model.ts";
import { accountPlanName } from "../../.upstream/packages/apps/src/contracts/account-plan-name.ts";

// Special display rules, rather than a second copy of the provider's complete tier catalog.
test("OpenAI special tiers, aliases and mixed-case IDs use the provider's names", () => {
  for (const [id, expected] of [
    ["pro", "Pro (More)"],
    ["prolite", "Pro"],
    ["promax", "Pro (Max)"],
    ["ProMax", "Pro (Max)"],
    ["PROMAX", "Pro (Max)"],
    ["PRO", "Pro (More)"],
    ["pro 20x", "Pro (More)"],
    ["pro 5x", "Pro"],
    ["pro-lite", "Pro"],
    ["pro_lite", "Pro"],
    ["ent26", "Enterprise"],
    ["hc", "Enterprise"],
    ["education", "Edu"],
    ["enterprise_cbp_automation", "Enterprise (Automation)"],
    ["enterprise_cbp_usage_based", "Enterprise CBP Usage Based"],
    ["self_serve_business_prolite", "Self Serve Business ProLite"],
    ["sci", "Academic Researchers"],
    ["sci_plus", "Academic Researchers Plus"],
  ] as const) {
    assert.equal(accountPlanName(id, "openai"), expected, id);
    assert.equal(accountPlanName(expected, "openai"), expected, `already named ${id}`);
  }
});

test("other providers keep their own names and an unqualified Pro stays Pro", () => {
  for (const name of [
    "Pro",
    "Max 5x",
    "Max 20x",
    "Team",
    "Enterprise",
    "SuperGrok",
    "SuperGrok Heavy",
    "Google AI Pro",
  ])
    assert.equal(accountPlanName(name), name);
  assert.equal(accountPlanName("pro", "claude"), "Pro");
});

test("unknown IDs are readable, blanks are named and inherited keys are not tiers", () => {
  for (const [id, expected] of [
    ["future_plan-tier", "Future Plan Tier"],
    ["constructor", "Constructor"],
    ["toString", "ToString"],
    ["", "Unknown"],
    ["   ", "Unknown"],
  ] as const)
    assert.equal(accountPlanName(id, "openai"), expected);
});

test("OpenAI-family key accounts and pool labels agree independently of auth method", () => {
  const account = Schema.decodeUnknownSync(Account)({
    id: "acc_synthetic",
    provider: "prv_opaque",
    method: "key",
    label: "Synthetic",
    description: null,
    owner: "usr_synthetic",
    createdAt: new Date("2026-11-07T12:00:00Z"),
  });
  const app = Schema.decodeUnknownSync(App)({
    id: "app_synthetic",
    slug: "synthetic",
    code: "code_synthetic",
    repository: null,
    owner: account.owner,
    name: "Synthetic",
    activeVersion: null,
    copiedFrom: null,
    createdAt: account.createdAt,
    requirements: {
      accounts: {
        service: {
          provider: account.provider,
          cardinality: "one",
          definition: {
            name: "Different display name",
            auth: {},
            family: { id: "openai", name: "OpenAI" },
          },
        },
      },
    },
  });
  const familyId = accountFamily({ apps: [app], links: [], accounts: [account] }, account)?.id;
  assert.equal(account.method, "key");
  assert.equal(familyId, "openai");
  for (const [id, expected] of [
    ["pro", "Pro (More)"],
    ["promax", "Pro (Max)"],
    ["prolite", "Pro"],
  ] as const) {
    const row = planLabel(
      {
        offering: "subscription",
        plan: { label: id, observedAt: "2026-11-07T12:00:00Z" },
        windows: [],
        balances: [],
      },
      familyId,
    );
    assert.equal(row, expected);
    for (const provider of ["openai", "codex"]) {
      assert.equal(planName(id, provider), row);
      assert.equal(candidateName({ label: id, source: "reported", capacity: 1 }, provider), row);
      assert.equal(exclusionName(id, provider), row);
    }
  }
});
