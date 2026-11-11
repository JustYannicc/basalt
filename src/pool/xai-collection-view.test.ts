import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolView, AccountObservationResponse } from "../../apps/pool/contract.ts";
import {
  xaiMonthlyFields,
  xaiWeeklyFields,
} from "../../apps/pool/collection-diagnostic-contract.ts";
import { collectionDiagnostic, retainCollectionDiagnostic } from "./collection-diagnostic.ts";
import { fixture, error } from "./test/control.ts";
import { HomeClient } from "./control.ts";

function handoff(at: string) {
  const fields = (paths: readonly string[]) =>
    Object.fromEntries(
      paths.map((path) => [path, { present: false, null: false, numeric: false }]),
    );
  const response = (paths: readonly string[]) => ({
    response_received: true,
    http_ok: true,
    json_valid: true,
    fields: fields(paths),
  });
  return {
    provider: "xai",
    attempted_at: at,
    xai: {
      phase: "snapshot_write_failed",
      vendor_call_started: true,
      probe_finished: true,
      snapshot_write_attempted: true,
      snapshot_persisted: false,
      monthly: {
        ...response(xaiMonthlyFields),
        fields: {
          ...fields(xaiMonthlyFields),
          config: { present: true, null: false, numeric: false },
          "config.used": { present: true, null: true, numeric: false },
          "config.monthlyLimit": { present: true, null: false, numeric: true },
          private_token: { present: true, raw: "private-secret" },
        },
      },
      weekly: response(xaiWeeklyFields),
      profile: {
        response_received: true,
        http_ok: true,
        json_valid: true,
        failure_reason: "unknown-tier",
        fields: {
          subscriptionTier: { present: true, null: false, string: true, raw: "private-secret" },
          subscription_tier: { present: false, null: false, string: false },
          private_field: { raw: "private-secret" },
        },
      },
      private_body: "private-secret",
    },
  };
}

test("existing owner observation and pool views retain exact xAI fields and skipped request reasons", async () => {
  const f = await fixture();
  f.home.addFile("a", "xai");
  f.home.addFile("foreign", "xai");
  f.home.addGroup("pool-a", 10, ["a"]);
  const at = f.deps.now().toISOString();
  const old = new Date(f.deps.now().getTime() - 3_600_000).toISOString();
  const next = new Date(f.deps.now().getTime() + 3_600_000).toISOString();
  let include = true;
  f.home.override = (path) =>
    path.endsWith("/quota/credentials/a")
      ? Response.json({
          credential: { credential_id: "a", provider: "xai" },
          windows: [],
          collection: {
            status: "failed",
            freshness: "never",
            last_attempt_at: old,
            next_probe_at: next,
            error: {
              code: "UPSTREAM_RESPONSE_INVALID",
              occurred_at: old,
              message: "private-secret",
            },
            diagnostic: include ? handoff(at) : null,
            request: { requested_at: at, disposition: "private-secret", raw: "private-secret" },
          },
        })
      : undefined;
  const refreshed = await f.call("/accounts/a/observations/refresh", { method: "POST" });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const result = (await refreshed.json()) as AccountObservationResponse;
  assert.equal(result.account.collection?.request?.disposition, "home_backoff");
  assert.equal(result.account.collection?.request?.homeAttemptAt, old);
  assert.equal(result.account.collection?.request?.nextAllowedAt, next);
  const diagnostic = result.account.collection?.diagnostic;
  assert.equal(diagnostic?.attemptedAt, at);
  assert.equal(diagnostic?.xai?.phase, "snapshot_write_failed");
  assert.equal(diagnostic?.xai?.vendorCallStarted, true);
  assert.equal(diagnostic?.xai?.snapshotPersisted, false);
  assert.deepEqual(diagnostic?.xai?.profile, {
    responseReceived: true,
    httpOk: true,
    jsonValid: true,
    failureReason: "unknown-tier",
    fields: {
      subscriptionTier: { present: true, null: false, string: true },
      subscription_tier: { present: false, null: false, string: false },
    },
  });
  assert.deepEqual(diagnostic?.xai?.monthly.fields["config.used"], {
    present: true,
    null: true,
    numeric: false,
  });
  assert.equal(f.home.calls.filter(({ path }) => path.endsWith("/quota/collect")).length, 0);
  const first = await f.call("/pool?fresh=true");
  assert.equal(first.status, 200);
  const body = await first.text();
  assert.ok(!body.includes("private-secret") && !body.includes("private_token"));
  assert.deepEqual(
    (JSON.parse(body) as PoolView).accounts.map(({ id }) => id),
    ["a"],
  );
  f.restart();
  f.advance(61_000);
  include = false;
  const retained = (await (await f.call("/pool?fresh=true")).json()) as PoolView;
  assert.deepEqual(retained.accounts[0]?.collection?.diagnostic, diagnostic);
  assert.equal(retained.accounts[0]?.collection?.lastAttemptAt, old);
  assert.equal(retained.accounts[0]?.collection?.request?.disposition, "home_backoff");
  await error(await f.call("/accounts/a/observations", { owner: false }), "not_owner", 403);
});

test("xAI handoffs reject malformed flags, impossible phases and mismatched providers", () => {
  const at = "2030-01-01T01:00:00.000Z";
  const valid = handoff(at);
  assert.ok(collectionDiagnostic(valid, "xai"));
  for (const value of [
    { ...valid, provider: "claude" },
    { ...valid, attempted_at: "private-secret" },
    { ...valid, xai: { ...valid.xai, phase: "private-secret" } },
    { ...valid, xai: { ...valid.xai, phase: "claimed" } },
    { ...valid, xai: { ...valid.xai, snapshot_persisted: true } },
    { ...valid, xai: { ...valid.xai, vendor_call_started: false } },
    { ...valid, xai: { ...valid.xai, monthly: { ...valid.xai.monthly, json_valid: false } } },
    {
      ...valid,
      xai: {
        ...valid.xai,
        monthly: {
          ...valid.xai.monthly,
          fields: {
            ...valid.xai.monthly.fields,
            "config.used": { present: false, null: true, numeric: false },
          },
        },
      },
    },
  ])
    assert.equal(collectionDiagnostic(value, "xai"), undefined);
});

test("older xAI evidence cannot replace a newer Home attempt, and stored copies drop unknown fields", async () => {
  let saved: unknown;
  const storage = {
    async get<T>() {
      return saved as T | undefined;
    },
    async put(_key: string, value: unknown) {
      saved = structuredClone(value);
    },
  };
  const reading = (at: string) => ({
    credential: { provider: "xai" },
    collection: { diagnostic: handoff(at) },
  });
  await retainCollectionDiagnostic(reading("2030-01-01T01:00:00Z"), "a", storage);
  await retainCollectionDiagnostic(reading("2030-01-01T00:00:00Z"), "a", storage);
  const latest = collectionDiagnostic(saved, "xai");
  assert.equal(latest?.attemptedAt, "2030-01-01T01:00:00.000Z");
  assert.equal(latest?.xai?.monthly.fields["config.used"].null, true);
  assert.ok(!JSON.stringify(saved).includes("private-"));
});

test("a delayed claimed HTTP reply cannot erase completed fields for the same Home attempt", async () => {
  const at = "2030-01-01T01:00:00.000Z";
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
  };
  const completed = handoff(at);
  const empty = (paths: readonly string[]) => ({
    response_received: false,
    http_ok: false,
    json_valid: false,
    fields: Object.fromEntries(
      paths.map((path) => [path, { present: false, null: false, numeric: false }]),
    ),
  });
  const claimed = {
    provider: "xai",
    attempted_at: at,
    xai: {
      phase: "claimed",
      vendor_call_started: false,
      probe_finished: false,
      snapshot_write_attempted: false,
      snapshot_persisted: false,
      monthly: empty(xaiMonthlyFields),
      weekly: empty(xaiWeeklyFields),
    },
  };
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let current: unknown = completed;
  const client = new HomeClient(
    async () => {
      const first = reads++ === 0;
      if (first) {
        began();
        await gate;
      }
      return Response.json({
        credential: { credential_id: "a", provider: "xai" },
        collection: { diagnostic: first ? claimed : current },
      });
    },
    undefined,
    undefined,
    storage,
  );
  const slow = client.data("/quota/credentials/a");
  await started;
  const fast = await client.data("/quota/credentials/a");
  release();
  const delayed = await slow;
  for (const value of [fast, delayed]) {
    const diagnostic = collectionDiagnostic(
      (value.collection as Record<string, unknown>).diagnostic,
      "xai",
    );
    assert.equal(diagnostic?.xai?.phase, "snapshot_write_failed");
    assert.equal(diagnostic?.xai?.vendorCallStarted, true);
    assert.equal(diagnostic?.xai?.monthly.fields["config.used"].null, true);
  }
  const next = "2030-01-01T01:01:00.000Z";
  current = { ...claimed, attempted_at: next };
  const newer = await client.data("/quota/credentials/a");
  const diagnostic = collectionDiagnostic(
    (newer.collection as Record<string, unknown>).diagnostic,
    "xai",
  );
  assert.equal(diagnostic?.attemptedAt, next);
  assert.equal(diagnostic?.xai?.phase, "claimed");
});

test("eligibility reasons stay closed and retain only fixed profile shape", async () => {
  const absent = { present: false, null: false, string: false };
  const text = { present: true, null: false, string: true };
  for (const reason of ["malformed", "missing", "ambiguous", "non-string", "unknown-tier"]) {
    const profile = {
      response_received: true,
      http_ok: true,
      json_valid: reason !== "malformed",
      failure_reason: reason,
      fields: {
        subscriptionTier:
          reason === "malformed" || reason === "missing"
            ? absent
            : reason === "non-string"
              ? { ...text, string: false }
              : text,
        subscription_tier: reason === "ambiguous" ? text : absent,
        private_field: "private-payload",
      },
      private_payload: "private-payload",
    };
    const at = "2030-01-01T01:00:00Z";
    const diagnostic = { ...handoff(at), xai: { ...handoff(at).xai, profile } };
    assert.equal(collectionDiagnostic(diagnostic, "xai")?.xai?.profile?.failureReason, reason);
    let saved: unknown;
    await retainCollectionDiagnostic(
      { credential: { provider: "xai" }, collection: { diagnostic } },
      "a",
      {
        async get<T>() {
          return saved as T | undefined;
        },
        async put(_key: string, value: unknown) {
          saved = value;
        },
      },
    );
    assert.equal(collectionDiagnostic(saved, "xai")?.xai?.profile?.failureReason, reason);
    assert.ok(!JSON.stringify(saved).includes("private"));
    for (const invalid of [
      { ...profile, failure_reason: "private-payload" },
      { ...profile, http_ok: false },
      {
        ...profile,
        fields: {
          ...profile.fields,
          subscriptionTier: { present: false, null: false, string: true },
        },
      },
    ]) {
      assert.equal(
        collectionDiagnostic(
          { ...diagnostic, xai: { ...diagnostic.xai, profile: invalid } },
          "xai",
        ),
        undefined,
      );
    }
  }
});
