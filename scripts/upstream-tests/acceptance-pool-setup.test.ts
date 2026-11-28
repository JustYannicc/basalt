import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  AcceptancePoolRefused,
  type AcceptancePoolSteps,
} from "../../.upstream/apps/hosted/server/src/contracts/acceptance-pool.ts";
import type { Operation } from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/contracts.ts";
import { upstreamOriginSha256 } from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/guard.ts";
import {
  runAcceptancePool,
  type RunnerSettings,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/runner.ts";
import { makeAcceptancePoolSteps } from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/steps.ts";
import { fixtureProduct, operationSchema } from "./acceptance-pool-fixture.ts";

const target = "https://app.example.test";
const host = "upstream.example.test";
const key = "u".repeat(40);
const settings = (overrides: Partial<RunnerSettings> = {}): RunnerSettings => ({
  target,
  release: "release-a",
  encryptionKey: "cd".repeat(32),
  databaseOrigin: { host: "db.example.test", port: 5432, database: "postgres" },
  upstreamHost: host,
  ...overrides,
});
const request = {
  pool: "acceptance-run-1",
  accounts: [
    { profile: "a", method: "anthropic", models: "model-a" },
    { profile: "b", method: "openai", models: "model-b" },
  ],
};
const recipient = await (async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
})();
const signed = (operation: Operation) => ({
  version: 1 as const,
  id: randomUUID(),
  target,
  at: 0,
  expiresAt: 60_000,
  operation,
});
const digest = upstreamOriginSha256(`https://${host}`);
const refusal = (error: unknown) => {
  assert.ok(error instanceof AcceptancePoolRefused, `expected a refusal, got ${String(error)}`);
  return error.reason;
};
const run = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(pgliteLayer()),
      Effect.provide(NodeCrypto.layer),
    ),
  );
const dryRun = (steps: AcceptancePoolSteps, body: unknown = request, s = settings()) =>
  runAcceptancePool(
    s,
    signed({
      kind: "setup",
      action: "dry-run",
      request: body as never,
      recipient,
      upstreamOriginSha256: digest,
    }),
    steps,
  );
const apply = (
  steps: AcceptancePoolSteps,
  planned: { readonly artifact: NonNullable<Operation["artifact"]>; readonly planSha256: string },
  s = settings(),
  body: unknown = request,
) =>
  runAcceptancePool(
    s,
    signed({
      kind: "setup",
      action: "apply",
      request: body as never,
      artifact: planned.artifact,
      planSha256: planned.planSha256,
      go: `GO ${planned.planSha256}`,
      upstreamOriginSha256: digest,
      upstreamKey: key,
    }),
    steps,
  );

test("a setup plans identity, one pool, its provider and two accounts, then applies and verifies them", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* dryRun(steps);
      assert.equal(planned.steps, 7);
      const applied = yield* apply(steps, planned);
      assert.equal("verification" in applied && applied.verification?.ok, true);
      assert.deepEqual(fixture.calls, [
        "createPool",
        "installProvider",
        "createAccount",
        "link",
        "createAccount",
        "link",
      ]);
      assert.equal(fixture.state.pools.length, 1);
      assert.equal(fixture.state.pools[0]?.name, "acceptance-run-1");
      // The address is the server's own: the deploy's host and the profile, never the request's.
      assert.deepEqual(
        fixture.accounts.map((account) => [
          account.method,
          account.fields.baseUrl,
          account.fields.models,
        ]),
        [
          ["anthropic", "https://upstream.example.test/a", "model-a"],
          ["openai", "https://upstream.example.test/b", "model-b"],
        ],
      );
      assert.ok(fixture.accounts.every((account) => account.fields.token === key));
      assert.ok(fixture.accounts.every((account) => /^acc_[0-9a-f-]{36}$/u.test(account.id)));
      const verified = yield* runAcceptancePool(
        settings(),
        signed({ kind: "setup", action: "verify", request: {}, planSha256: planned.planSha256 }),
        steps,
      );
      assert.equal(verified.action === "verify" && verified.verification.ok, true);
    }),
  ));

test("an address in the request is never used, and a host that moved after the plan refuses", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const smuggled = {
        ...request,
        baseUrl: "https://elsewhere.example.test",
        accounts: request.accounts.map((account) => ({
          ...account,
          baseUrl: "https://elsewhere.example.test",
        })),
      };
      const planned = yield* dryRun(steps, smuggled);
      const moved = yield* Effect.flip(
        apply(steps, planned, settings({ upstreamHost: "moved.example.test" }), smuggled),
      );
      assert.equal(refusal(moved), "upstream_differs");
      assert.deepEqual(fixture.calls, []);
      yield* apply(steps, planned, settings(), smuggled);
      assert.ok(
        fixture.accounts.every((account) =>
          account.fields.baseUrl.startsWith("https://upstream.example.test/"),
        ),
      );
      assert.ok(!JSON.stringify(fixture.accounts).includes("elsewhere"));
    }),
  ));

test("an identity that already holds a pool, or owns an app the operation did not record, is refused", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const held = fixtureProduct();
      held.state.pools.push({
        app: "app_old",
        request: "r",
        name: "acceptance-old",
        owner: "acceptance",
        primary: true,
        live: true,
      });
      held.state.apps.push({ id: "app_old", name: "acceptance-old" });
      assert.equal(
        refusal(yield* Effect.flip(dryRun(makeAcceptancePoolSteps(held.product)))),
        "identity_holds_pool",
      );
      const stray = fixtureProduct();
      stray.state.apps.push({ id: "app_stray", name: "Something" });
      assert.equal(
        refusal(yield* Effect.flip(dryRun(makeAcceptancePoolSteps(stray.product)))),
        "unrecorded_app",
      );
      // A pool record whose app is gone is the product's own deletion marker, not a held pool.
      const marked = fixtureProduct();
      marked.state.pools.push({
        app: "app_gone",
        request: "r",
        name: "acceptance-old",
        owner: "acceptance",
        primary: true,
        live: false,
      });
      yield* dryRun(makeAcceptancePoolSteps(marked.product));
      // A pool that appears between the plan and its apply refuses the first apply before it acts.
      const late = fixtureProduct();
      const steps = makeAcceptancePoolSteps(late.product);
      const planned = yield* dryRun(steps);
      late.state.pools.push({
        app: "app_late",
        request: "r",
        name: "acceptance-late",
        owner: "acceptance",
        primary: true,
        live: true,
      });
      assert.equal(refusal(yield* Effect.flip(apply(steps, planned))), "identity_holds_pool");
      late.state.pools[0] = { ...late.state.pools[0]!, live: false };
      late.state.apps.push({ id: "app_other", name: "Other" });
      assert.equal(refusal(yield* Effect.flip(apply(steps, planned))), "unrecorded_app");
      late.state.apps.length = 0;
      assert.equal(
        refusal(yield* Effect.flip(apply(steps, planned))),
        "stale_plan",
        "the marker changed the pools digest",
      );
      assert.deepEqual(late.calls, []);
    }),
  ));

test("a link is refused while the pool holds one the operation did not record", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const base = makeAcceptancePoolSteps(fixture.product);
      const steps: AcceptancePoolSteps = {
        ...base,
        run: (step, context) =>
          Effect.gen(function* () {
            const value = yield* base.run(step, context);
            // Someone links a foreign account once the pool exists.
            if (step === "provider")
              fixture.state.links.push({
                app: fixture.state.pools[0]!.app,
                requirement: "custom",
                account: "acc_foreign",
              });
            return value;
          }),
      };
      const planned = yield* dryRun(steps);
      assert.equal(refusal(yield* Effect.flip(apply(steps, planned))), "unrecorded_link");
      assert.ok(!fixture.calls.includes("link"));
    }),
  ));

test("a reply lost after the pool was created resumes without a second pool", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct({ failAfter: new Set(["createPool", "createAccount"]) });
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* dryRun(steps);
      const lost = yield* Effect.flip(apply(steps, planned));
      assert.equal(refusal(lost), "step_failed");
      assert.equal(
        fixture.state.pools.length,
        1,
        "the product created the pool before the reply was lost",
      );
      const again = yield* Effect.flip(apply(steps, planned));
      assert.equal(refusal(again), "step_failed", "the first account's reply is lost too");
      const resumed = yield* apply(steps, planned);
      assert.equal("resumed" in resumed && resumed.resumed, true);
      assert.equal(fixture.state.pools.length, 1, "still one pool");
      assert.equal(fixture.state.apps.length, 2, "one pool app and one provider app");
      assert.equal(fixture.accounts.length, 2, "one account per profile");
      assert.equal("verification" in resumed && resumed.verification?.ok, true);
    }),
  ));
