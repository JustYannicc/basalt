import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaObservation } from "./quota-observation.ts";
import { retainCollectionDiagnostic, collectionDiagnostic } from "./collection-diagnostic.ts";

const flags = {
  present: true,
  null: false,
  quantity_null: false,
  quantity_valid: true,
  five_hour: true,
};
const base = {
  provider: "claude",
  attempted_at: "2026-11-10T13:00:00Z",
  response_received: true,
  json_valid: true,
};

test("field diagnostics distinguish zero, null window, null quantity and absence without values", () => {
  for (const field of [
    flags,
    { ...flags, null: true, quantity_valid: false, five_hour: false },
    { ...flags, quantity_null: true, quantity_valid: false },
    { present: false, null: false, quantity_null: false, quantity_valid: false, five_hour: false },
  ]) {
    const result = collectionDiagnostic(
      { ...base, five_hour: { ...field, utilization: 99, token: "private-secret" } },
      "claude",
    );
    assert.deepEqual(result?.fiveHour, {
      present: field.present,
      null: field.null,
      quantityNull: field.quantity_null,
      quantityValid: field.quantity_valid,
      fiveHour: field.five_hour,
    });
    assert.ok(!JSON.stringify(result).includes("private-"));
    assert.ok(!JSON.stringify(result).includes("utilization"));
  }
});

test("malformed, cross-provider and impossible diagnostic states do not reach the view", () => {
  for (const bad of [
    null,
    {},
    { ...base, provider: "codex", five_hour: flags },
    { ...base, attempted_at: "private-secret", five_hour: flags },
    { ...base, response_received: false, five_hour: flags },
    { ...base, five_hour: { ...flags, present: "true" } },
    { ...base, five_hour: { ...flags, present: false } },
    { ...base, five_hour: { ...flags, quantity_null: true } },
  ]) {
    assert.equal(collectionDiagnostic(bad, "claude"), undefined);
  }
});

test("idle five-hour decoder preserves explicit zero without inventing a reset or a missing window", async () => {
  const { publicQuotaObservation } = await import("./quota-observation-public.ts");
  const detail = {
    credential: { credential_id: "fixture" },
    collection: { observed_at: "2026-11-10T13:00:00Z", status: "success" },
    windows: [
      {
        id: "claude-five-hour",
        unit: "percentage",
        scope: "account",
        window_seconds: 18000,
        observed_at: "2026-11-10T13:00:00Z",
        used: 0,
        remaining: 100,
        limit: 100,
        remaining_ratio: 1,
        reset_at: null,
      },
    ],
  };
  for (const id of ["claude-five-hour", "codex-5-hour"]) {
    const decoded = publicQuotaObservation(
      quotaObservation({ ...detail, windows: [{ ...detail.windows[0], id }] }),
    );
    assert.equal(decoded?.observation.windows[0]?.measure.used, 0);
    assert.equal(decoded?.observation.windows[0]?.measure.remainingRatio, 1);
    assert.equal(decoded?.observation.windows[0]?.resetsAt, undefined);
  }
  assert.deepEqual(
    publicQuotaObservation(quotaObservation({ ...detail, windows: [] }))?.observation.windows,
    [],
  );
});

test("a delayed older read cannot replace a newer stored diagnostic", async () => {
  let saved: unknown;
  let first = true;
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage = {
    async get<T>() {
      if (first) {
        first = false;
        began();
        await gate;
        return undefined;
      }
      return saved as T | undefined;
    },
    async put(_key: string, value: unknown) {
      saved = structuredClone(value);
    },
  };
  const reading = (at: string) => ({
    credential: { provider: "claude" },
    collection: { diagnostic: { ...base, attempted_at: at, five_hour: flags } },
  });
  const older = retainCollectionDiagnostic(reading("2026-11-10T13:00:00Z"), "fixture", storage);
  await started;
  const newer = retainCollectionDiagnostic(reading("2026-11-10T13:01:00Z"), "fixture", storage);
  release();
  await Promise.all([older, newer]);
  assert.equal(collectionDiagnostic(saved, "claude")?.attemptedAt, "2026-11-10T13:01:00.000Z");
});
