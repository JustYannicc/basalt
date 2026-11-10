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
  options: {
    unnamed?: boolean;
    error?: string;
    upstreamStatus?: unknown;
    errorAt?: string;
    homeStatus?: number;
    transportFailure?: boolean;
    stale?: boolean;
    disabled?: boolean;
    deleted?: boolean;
    exhausted?: boolean;
    unlimited?: boolean;
    provider?: string;
    first?: boolean;
    stalled?: boolean;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const calls: string[] = [],
    storage = new Map<string, unknown>();
  let completed = !options.stale && !options.first,
    queued = false;
  const client = new HomeClient(
    async (path) => {
      calls.push(path);
      if (path.endsWith("/credentials"))
        return Response.json({
          files: [
            {
              id: "bound-id",
              provider: options.provider ?? "codex",
              ...(options.unnamed ? {} : { email: "subscriber@example.test" }),
              disabled: options.disabled,
              deleted: options.deleted,
            },
          ],
        });
      if (path.endsWith("/quota/collect")) {
        queued = true;
        completed = !options.stalled && !(options.first && options.error);
        return Response.json({ accepted: 1 });
      }
      assert.ok(path.endsWith("/quota/credentials/bound-id"));
      if (options.transportFailure) throw new TypeError("PRIVATE_TRANSPORT_DIAGNOSTIC");
      if (options.homeStatus)
        return Response.json(
          { message: "PRIVATE_HOME_DIAGNOSTIC" },
          { status: options.homeStatus },
        );
      return Response.json({
        credential: { credential_id: "bound-id", plan: { name: "Pro" } },
        collection: {
          status: options.error
            ? "failed"
            : completed
              ? "success"
              : queued
                ? "collecting"
                : options.first
                  ? "idle"
                  : "success",
          freshness: completed ? "fresh" : "stale",
          ...(options.first && !completed
            ? {}
            : { observed_at: new Date(now - (completed ? 0 : 31 * 60_000)).toISOString() }),
          last_attempt_at: new Date(now - (completed || queued ? 0 : 31 * 60_000)).toISOString(),
          ...(options.error
            ? {
                error: {
                  code: options.error,
                  upstream_status_code: options.upstreamStatus,
                  occurred_at: options.errorAt,
                  request_id: "PRIVATE_VENDOR_REQUEST_ID",
                  message: "PRIVATE_DIAGNOSTIC",
                },
              }
            : {}),
        },
        windows:
          options.first && !completed
            ? []
            : [
                {
                  id: "codex-week",
                  label: "Weekly",
                  unit: "percent",
                  limit: 100,
                  remaining: options.exhausted ? 0 : 80,
                  remaining_ratio: options.exhausted ? 0 : 0.8,
                  observed_at: new Date(now - (completed ? 0 : 31 * 60_000)).toISOString(),
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
    { now: () => now, ...(options.wait ? { wait: options.wait } : {}) },
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

test("signed retirement reference checks read only the exact surviving credential and return fixed codes", async () => {
  for (const [options, changes, verified] of [
    [{}, {}, true],
    [{ disabled: true }, {}, true],
    [{ deleted: true }, {}, false],
    [{ provider: "claude" }, {}, false],
    [{}, { reference: "missing-id" }, false],
    [{}, { reference: 'sbhrefs1:["bound-id","other-id"]' }, false],
  ] as const) {
    const f = fixture(options);
    const response = await f.check({ action: "verify-retirement-reference", ...changes });
    assert.equal(response?.status, 200);
    assert.deepEqual(await response!.json(), {
      verified,
      code: verified ? "retirement_reference_verified" : "retirement_reference_unavailable",
    });
    assert.deepEqual(f.calls, ["/v8/management/credentials"]);
  }
  assert.equal((await fixture().unsigned())?.status, 403);
});

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

test("an unnamed native subscription keeps health and usage without exposing its reference", async () => {
  const response = await fixture({ unnamed: true }).check();
  assert.equal(response?.status, 200);
  const body = (await response!.json()) as {
    result: { accountInfo: unknown; observation: unknown };
  };
  assert.deepEqual(body.result.accountInfo, {});
  assert.ok(body.result.observation);
  assert.equal(JSON.stringify(body).includes("bound-id"), false);
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
    const body = await response!.json();
    assert.equal(body.failure, failure);
    assert.equal(JSON.stringify(body).includes("PRIVATE_"), false);
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
    assert.equal((await (await f.check(changes))!.json()).diagnostic.source, "home");
  assert.equal(
    f.calls.some((path) => path.includes("/quota/")),
    false,
  );
});

test("alarm observations read unlinked bindings without a health check or reset mutations", async () => {
  const f = fixture({ stale: true });
  const first = await f.check({ action: "observe" });
  assert.equal(first?.status, 200);
  const old = (await first!.json()) as { result: { observedAt: string } };
  const second = await f.check({ action: "observe" });
  const fresh = (await second!.json()) as { result: { observedAt: string } };
  // Both calls see the same completed reading; the old test required a second pass.
  assert.equal(old.result.observedAt, new Date(now).toISOString());
  assert.equal(fresh.result.observedAt, old.result.observedAt);
  assert.equal(fresh.result.observedAt, new Date(now).toISOString());
  assert.equal(f.calls.filter((path) => path.endsWith("/quota/collect")).length, 1);
  assert.ok(
    f.calls.every((path) =>
      /\/(credentials|quota\/collect|quota\/credentials\/bound-id)$/.test(path),
    ),
  );
});

test("an unlimited account reports its windows as unlimited instead of no reading", async () => {
  const f = fixture({ unlimited: true });
  const response = await f.check({ action: "observe" });
  const body = (await response!.json()) as {
    result: { observation: { windows: { measure: { unlimited?: boolean } }[] } } | null;
  };
  assert.ok(body.result, "an unlimited reading is a reading, not an unavailable source");
  assert.deepEqual(
    body.result.observation.windows.map((window) => window.measure.unlimited),
    [true],
  );
});

test("unsupported native accounts never schedule quota collection", async () => {
  for (const provider of ["typesafe", "vertex", "gemini-cli", "devin", "kimi-ai"]) {
    const f = fixture({ provider, stale: true });
    const response = await f.check({ action: "observe", provider });
    assert.deepEqual(await response!.json(), { result: null });
    await f.check({ action: "check", provider });
    assert.equal(f.calls.filter((path) => path.includes("/quota/")).length, 0, provider);
  }
});

test("a first alarm collection publishes its new reading in the same pass", async () => {
  const f = fixture({ first: true });
  const body = (await (await f.check({ action: "observe" }))!.json()) as {
    result: { observedAt: string; collection: { outcome: string } };
  };
  assert.equal(body.result.observedAt, new Date(now).toISOString());
  assert.equal(body.result.collection.outcome, "success");
  assert.equal(f.calls.filter((path) => path.endsWith("/quota/collect")).length, 1);
});

test("the nine-second bound retains source time or a neutral first reading without a failure", async (t) => {
  const original = AbortSignal.timeout;
  for (const first of [false, true]) {
    const budget = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms: number) =>
      ms === 9_000 ? budget.signal : original(ms),
    );
    const f = fixture({
      first,
      stale: true,
      stalled: true,
      wait: async (_ms, signal) => {
        budget.abort(new DOMException("Collection wait ended", "TimeoutError"));
        signal.throwIfAborted();
      },
    });
    const response = await f.check({ action: "observe" });
    const body = (await response!.json()) as {
      result:
        | import("../../apps/pool/account-observation-contract.ts").PoolAccountObservation
        | null;
    };
    assert.equal(response!.status, 200);
    assert.ok("result" in body, "a wait timeout is not a backend failure");
    if (first) assert.equal(body.result, null, "no reading is pending, not unavailable");
    else {
      assert.ok(body.result);
      assert.equal(body.result.observedAt, new Date(now - 31 * 60_000).toISOString());
      assert.equal(body.result.collection, undefined);
      const { nextObservationState } =
        await import("../../.upstream/packages/sdk/src/implementation/account-observation-state.ts");
      const saved = nextObservationState({
        result: body.result,
        outcome: "success",
        startedAt: now,
        now,
      });
      assert.equal(saved.lastAttempt.outcome, "success");
      assert.equal(saved.result?.observedAt, body.result.observedAt);
    }
    assert.equal(f.calls.filter((path) => path.endsWith("/quota/collect")).length, 1);
    t.mock.restoreAll();
  }
});

test("a first collection that actually fails reports its failure even without a reading", async () => {
  for (const [error, failure] of [
    ["UPSTREAM_RATE_LIMITED", "rate_limited"],
    ["UPSTREAM_UNAVAILABLE", "unavailable"],
  ]) {
    const f = fixture({ first: true, error });
    assert.equal((await (await f.check({ action: "observe" }))!.json()).failure, failure);
  }
});

test("failed native reads retain the provider status and failure time without a usage reading", async () => {
  const occurredAt = "2029-12-31T23:59:58.123Z";
  for (const first of [true, false]) {
    const f = fixture({
      first,
      error: "UPSTREAM_UNAVAILABLE",
      upstreamStatus: 426,
      errorAt: occurredAt,
    });
    for (const action of ["check", "observe"]) {
      const response = await f.check({ action });
      assert.deepEqual(await response!.json(), {
        failure: "unavailable",
        diagnostic: { source: "provider", reason: "unavailable", status: 426, occurredAt },
      });
    }
  }
});

test("Home HTTP statuses and transport failures never become provider status evidence", async () => {
  for (const [options, source] of [
    [{ homeStatus: 426 }, "home"],
    [{ transportFailure: true }, "transport"],
  ] as const) {
    const response = await fixture(options).check({ action: "observe" });
    assert.deepEqual(await response!.json(), {
      failure: "unavailable",
      diagnostic: { source, reason: "unavailable", occurredAt: new Date(now).toISOString() },
    });
  }
});

test("collector diagnostics accept only bounded status and normalized failure times", async () => {
  for (const upstreamStatus of [401, 403, 429, 426, "426", 0, 600, 426.5, null]) {
    const valid =
      typeof upstreamStatus === "number" &&
      Number.isInteger(upstreamStatus) &&
      upstreamStatus >= 100 &&
      upstreamStatus <= 599;
    const error =
      upstreamStatus === 401 || upstreamStatus === 403
        ? "UPSTREAM_AUTH_REJECTED"
        : upstreamStatus === 429
          ? "UPSTREAM_RATE_LIMITED"
          : "UPSTREAM_UNAVAILABLE";
    const body = await (await fixture({
      first: true,
      error,
      upstreamStatus,
      errorAt: "2099-01-01T00:00:00Z",
    }).check({ action: "observe" }))!.json();
    assert.equal(body.diagnostic.status, valid ? upstreamStatus : undefined);
    assert.equal(body.diagnostic.source, valid ? "provider" : "transport");
    assert.equal(body.diagnostic.occurredAt, new Date(now).toISOString());
    assert.equal(/PRIVATE_|bound-id/.test(JSON.stringify(body)), false);
  }
});

test("failure times normalize vendor precision and reject invalid calendar dates", async () => {
  for (const [errorAt, expected] of [
    ["2029-12-31T23:59:58.123456789Z", "2029-12-31T23:59:58.123Z"],
    ["2030-01-01T00:59:58+01:00", "2029-12-31T23:59:58.000Z"],
    ["2029-02-29T00:00:00Z", new Date(now).toISOString()],
    ["not a date", new Date(now).toISOString()],
  ]) {
    const body = await (await fixture({
      first: true,
      error: "UPSTREAM_UNAVAILABLE",
      upstreamStatus: 426,
      errorAt,
    }).check({ action: "observe" }))!.json();
    assert.equal(body.diagnostic.occurredAt, expected);
  }
});
