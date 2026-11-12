import assert from "node:assert/strict";
import { test } from "node:test";
import { resetObservation } from "./reset-observation.ts";
import { accountsView, retainedAccount } from "./accounts-view.ts";
import { quotaObservation } from "./quota-observation.ts";
import { publicQuotaObservation } from "./quota-observation-public.ts";
import { capacity } from "../../apps/pool/ui/usage.ts";

const now = Date.parse("2026-11-12T09:00:00Z");
const at = new Date(now).toISOString();
const grants = {
  available_count: 4,
  observed_at: at,
  credits: [
    {
      status: "available",
      remaining: 3,
      kind: "model",
      scope: "model",
      scope_id: "fable",
      clears: ["claude-seven-day-fable"],
      gives_back_weekly: true,
      expires_at: "2027-03-09T07:59:00Z",
    },
    {
      status: "available",
      remaining: 1,
      kind: "weekly",
      scope: "account",
      clears: ["claude-seven-day"],
      expires_at: "2026-12-10T22:00:00Z",
    },
  ],
};

test("three model resets and one whole-week reset remain distinct through native and pool reports", () => {
  const detail = {
    credential: { credential_id: "synthetic", plan: { name: "Max 20x" } },
    collection: {
      status: "success",
      freshness: "fresh",
      observed_at: at,
      expires_at: "2026-11-12T09:30:00Z",
    },
    windows: [
      {
        id: "claude-seven-day",
        scope: "account",
        unit: "percentage",
        remaining_ratio: 0.8,
        window_seconds: 604800,
        observed_at: at,
      },
      {
        id: "claude-seven-day-fable",
        label: "Fable weekly",
        scope: "model",
        scope_id: "fable",
        unit: "percentage",
        remaining_ratio: 0,
        window_seconds: 604800,
        observed_at: at,
        reset_at: "2026-11-14T12:00:00Z",
      },
      {
        id: "claude-seven-day-new-model",
        label: "New Model weekly",
        scope: "model",
        scope_id: "new-model",
        unit: "percentage",
        remaining_ratio: 0.5,
        window_seconds: 604800,
        observed_at: at,
      },
    ],
    reset_credits: grants,
  };
  const account = accountsView(
    [{ id: "synthetic", provider: "claude" }],
    [detail],
    new Set(["synthetic"]),
    now,
  )[0]!;
  const report = publicQuotaObservation(quotaObservation(detail, now))!;
  assert.equal(account.bankedResets?.available, 4);
  assert.deepEqual(
    account.bankedResets?.groups?.map((group) => [group.label, group.available, group.expiresAt]),
    [
      ["Weekly resets", 1, "2026-12-10T22:00:00.000Z"],
      ["Fable resets", 3, "2027-03-09T07:59:00.000Z"],
    ],
  );
  assert.deepEqual(
    report.observation.balances.map(({ label, available, scope, reset, expiresAt }) => ({
      label,
      available,
      scope,
      reset,
      expiresAt,
    })),
    account.bankedResets?.groups?.map((group) => ({ ...group })),
  );
  assert.equal(account.windows.find((window) => window.scope?.id === "fable")?.remainingRatio, 0);
  assert.equal(
    report.observation.windows.find((window) => window.scope?.id === "new-model")?.period?.seconds,
    604800,
  );
  assert.equal(
    capacity([account])[0]?.left,
    0.8,
    "model limits never add accounts or change account-wide capacity",
  );
  assert.equal(
    retainedAccount(account, Date.parse("2026-12-11T00:00:00Z")).bankedResets?.available,
    3,
    "retained pool snapshots age out expired resets",
  );
});

test("old totals, inconsistent details, expiry and malformed counts never invent a weekly reset", () => {
  const old = resetObservation({ available_count: 9, credits: [] }, now)!;
  assert.equal(old.groups[0]?.scope.kind, "unknown");
  assert.equal(old.groups[0]?.reset.kind, "unknown");
  assert.equal(old.groups[0]?.available, 9);
  const conflict = resetObservation({ ...grants, available_count: 2 }, now)!;
  assert.equal(conflict.available, 2);
  assert.ok(conflict.groups.every((group) => group.scope.kind === "unknown"));
  assert.equal(resetObservation(grants, Date.parse("2027-03-09T07:59:00Z"))?.available, 0);
  for (const available_count of [-1, 1.5, Infinity, "4", 1_000_001])
    assert.equal(resetObservation({ available_count, credits: [] }, now), null);
});

test("native reports preserve more than eight model windows and expiry groups", () => {
  const windows = Array.from({ length: 12 }, (_, index) => ({
    id: `model-${index}`,
    label: `Model ${index} weekly`,
    scope: "model",
    scope_id: `model-${index}`,
    unit: "percentage",
    remaining_ratio: 0.5,
    window_seconds: 604800,
    observed_at: at,
  }));
  const credits = windows.map((_, index) => ({
    status: "available",
    remaining: 1,
    scope: "model",
    scope_id: `model-${index}`,
    kind: "model",
    expires_at: new Date(now + (index + 1) * 86_400_000).toISOString(),
  }));
  const report = publicQuotaObservation(
    quotaObservation(
      { credential: { observed_at: at }, windows, reset_credits: { available_count: 12, credits } },
      now,
    ),
  );
  assert.equal(report?.observation.windows.length, 12);
  assert.equal(report?.observation.balances.length, 12);
});

test("the native report producer emits at most 64 windows and balances", () => {
  const windows = Array.from({ length: 65 }, (_, index) => ({
    id: `model-${index}`,
    label: `Model ${index} weekly`,
    scope: "model",
    scope_id: `model-${index}`,
    unit: "percentage",
    remaining_ratio: 0.5,
    window_seconds: 604800,
    observed_at: at,
  }));
  const credits = windows.map((_, index) => ({
    status: "available",
    remaining: 1,
    scope: "model",
    scope_id: `model-${index}`,
    kind: "model",
    expires_at: new Date(now + (index + 1) * 86_400_000).toISOString(),
  }));
  const report = publicQuotaObservation(
    quotaObservation(
      { credential: { observed_at: at }, windows, reset_credits: { available_count: 65, credits } },
      now,
    ),
  )!;
  assert.equal(report.observation.windows.length, 64);
  assert.equal(report.observation.balances.length, 64);
  assert.equal(report.observation.windows[63]?.scope?.id, "model-63");
  assert.equal(report.observation.balances[63]?.scope?.id, "model-63");
});
