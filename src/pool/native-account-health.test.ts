import assert from "node:assert/strict";
import test from "node:test";
import { nativeAccountHealth } from "./account-health.ts";
import {
  accountAcquisitionPrefix,
  accountAcquisitionPath,
} from "./account-acquisition-contract.ts";
import { HomeClient } from "./control.ts";
import { QuotaCollection } from "./quota-collection.ts";
import { signEnvelope } from "./token.ts";
import type { Json } from "./json.ts";

const key = "ab".repeat(32),
  now = Date.parse("2030-01-01T00:00:00Z");
function fixture(
  options: { error?: string; stale?: boolean; disabled?: boolean; exhausted?: boolean; unlimited?: boolean; provider?: string } = {},
) {
  const calls: string[] = [],
    storage = new Map<string, unknown>();
  let completed = !options.stale;
  const client = new HomeClient(
    async (path) => {
      calls.push(path);
      if (path.endsWith("/credentials"))
        return Response.json({
          files: [
            {
              id: "bound-id",
              provider: options.provider ?? "codex",
              email: "subscriber@example.test",
              disabled: options.disabled,
            },
          ],
        });
      if (path.endsWith("/quota/collect")) {
        completed = true;
        return Response.json({ accepted: 1 });
      }
      assert.ok(path.endsWith("/quota/credentials/bound-id"));
      return Response.json({
        credential: { credential_id: "bound-id", plan: { name: "Pro" } },
        collection: {
          status: options.error ? "failed" : "success",
          freshness: completed ? "fresh" : "stale",
          observed_at: new Date(now - (completed ? 0 : 31 * 60_000)).toISOString(),
          last_attempt_at: new Date(now - (completed ? 0 : 31 * 60_000)).toISOString(),
          ...(options.error
            ? { error: { code: options.error, message: "PRIVATE_DIAGNOSTIC" } }
            : {}),
        },
        windows: [
          {
            id: "codex-week",
            label: "Weekly",
            unit: "percent",
            limit: 100,
            remaining: options.exhausted ? 0 : 80,
            remaining_ratio: options.exhausted ? 0 : 0.8,
            observed_at: new Date(now).toISOString(),
            period: { seconds: 604800 },
            ...(options.unlimited ? { is_unlimited: true } : {}),
          },
        ],
      });
    },
    () => now,
  );
  const collection = new QuotaCollection(
    {
      get: async <T>(name: string) => storage.get(name) as T | undefined,
      put: async (name, value) => {
        storage.set(name, value);
      },
    },
    client,
    { now: () => now },
  );
  const input = { client, collection, signingKey: key, now: () => now };
  return {
    calls,
    async check(changes: Json = {}) {
      const envelope = await signEnvelope(key, accountAcquisitionPrefix, {
        owner: "organization:synthetic",
        operation: "check:synthetic",
        action: "check",
        provider: "codex",
        reference: "bound-id",
        at: now,
        expiresAt: now + 30_000,
        ...changes,
      });
      return nativeAccountHealth(
        new Request(`https://pool.example.test${accountAcquisitionPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envelope }),
        }),
        input,
      );
    },
    unsigned: () =>
      nativeAccountHealth(
        new Request(`https://pool.example.test${accountAcquisitionPath}`, {
          method: "POST",
          body: JSON.stringify({ envelope: "invalid" }),
        }),
        input,
      ),
  };
}

test("native subscription checks work before pool linking and keep paused or exhausted credentials healthy", async () => {
  for (const options of [{}, { disabled: true }, { exhausted: true }]) {
    const f = fixture(options),
      response = await f.check();
    assert.equal(response?.status, 200);
    const body = (await response!.json()) as {
      result: { accountInfo: { email: string }; observation: unknown };
    };
    assert.equal(body.result.accountInfo.email, "subscriber@example.test");
    assert.ok(body.result.observation);
    assert.equal(JSON.stringify(body).includes("bound-id"), false);
    assert.equal(
      f.calls.some((path) => path.includes("channel-group")),
      false,
    );
  }
});

test("native checks preserve credential rejection and rate limits without returning backend diagnostics", async () => {
  for (const [error, failure] of [
    ["UPSTREAM_AUTH_REJECTED", "unauthorized"],
    ["AUTH_TOKEN_UNAVAILABLE", "unauthorized"],
    ["UPSTREAM_RATE_LIMITED", "rate_limited"],
    ["UPSTREAM_UNAVAILABLE", "unavailable"],
  ]) {
    const f = fixture({ error }),
      response = await f.check();
    assert.deepEqual(await response!.json(), { failure });
  }
});

test("a stale native check waits for a completed collection and shares the persisted collection cap", async () => {
  const f = fixture({ stale: true });
  for (let attempt = 0; attempt < 2; attempt++)
    assert.ok("result" in (await (await f.check())!.json()));
  assert.equal(f.calls.filter((path) => path.endsWith("/quota/collect")).length, 1);
});

test("invalid assertions and mismatched bindings never probe another credential", async () => {
  const f = fixture();
  assert.equal((await f.unsigned())?.status, 403);
  assert.equal((await f.check({ expiresAt: now }))?.status, 403);
  assert.equal(f.calls.length, 0);
  for (const changes of [
    { provider: "claude" },
    { reference: "another-id" },
    { reference: 'sbhrefs1:["bound-id","another-id"]' },
  ])
    assert.deepEqual(await (await f.check(changes))!.json(), { failure: "unauthorized" });
  assert.equal(
    f.calls.some((path) => path.includes("/quota/")),
    false,
  );
});


test("alarm observations read unlinked bindings without a health check or reset mutations", async () => {
  const f = fixture({ stale: true });
  const first = await f.check({ action: "observe" });
  assert.equal(first?.status, 200);
  const old = await first!.json() as { result: { observedAt: string } };
  const second = await f.check({ action: "observe" });
  const fresh = await second!.json() as { result: { observedAt: string } };
  assert.ok(Date.parse(fresh.result.observedAt) > Date.parse(old.result.observedAt));
  assert.equal(fresh.result.observedAt, new Date(now).toISOString());
  assert.equal(f.calls.filter((path) => path.endsWith("/quota/collect")).length, 1);
  assert.ok(f.calls.every((path) => /\/(credentials|quota\/collect|quota\/credentials\/bound-id)$/.test(path)));
});


test("an unlimited account reports its windows as unlimited instead of no reading", async () => {
  const f = fixture({ unlimited: true });
  const response = await f.check({ action: "observe" });
  const body = (await response!.json()) as {
    result: { observation: { windows: { measure: { unlimited?: boolean } }[] } } | null;
  };
  assert.ok(body.result, "an unlimited reading is a reading, not an unavailable source");
  assert.deepEqual(body.result.observation.windows.map((window) => window.measure.unlimited), [true]);
});

test("mirrored API-limited accounts share interval collection and the same persisted cap", async () => {
  const f = fixture({ provider: "typesafe", stale: true });
  await f.check({ action: "observe", provider: "typesafe" });
  const response = await f.check({ action: "observe", provider: "typesafe" });
  const body = await response!.json() as { result: { observedAt: string } };
  assert.equal(body.result.observedAt, new Date(now).toISOString());
  assert.equal(f.calls.filter((path) => path.endsWith("/quota/collect")).length, 1);
});
