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
const settings: RunnerSettings = {
  target,
  release: "release-a",
  encryptionKey: "cd".repeat(32),
  databaseOrigin: { host: "db.example.test", port: 5432, database: "postgres" },
  upstreamHost: host,
};
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
type Planned = {
  readonly artifact: NonNullable<Operation["artifact"]>;
  readonly planSha256: string;
};
const operate = (steps: AcceptancePoolSteps, operation: Operation) =>
  runAcceptancePool(settings, signed(operation), steps);
const setupDry = (steps: AcceptancePoolSteps) =>
  operate(steps, {
    kind: "setup",
    action: "dry-run",
    request,
    recipient,
    upstreamOriginSha256: upstreamOriginSha256(`https://${host}`),
  });
const setupApply = (steps: AcceptancePoolSteps, planned: Planned) =>
  operate(steps, {
    kind: "setup",
    action: "apply",
    request,
    artifact: planned.artifact,
    planSha256: planned.planSha256,
    go: `GO ${planned.planSha256}`,
    upstreamOriginSha256: upstreamOriginSha256(`https://${host}`),
    upstreamKey: "u".repeat(40),
  });
const teardownDry = (steps: AcceptancePoolSteps, setup: string) =>
  operate(steps, { kind: "teardown", action: "dry-run", request: { setup }, recipient });
const teardownApply = (steps: AcceptancePoolSteps, setup: string, planned: Planned) =>
  operate(steps, {
    kind: "teardown",
    action: "apply",
    request: { setup },
    artifact: planned.artifact,
    planSha256: planned.planSha256,
    go: `GO ${planned.planSha256}`,
  });
const verify = (steps: AcceptancePoolSteps, kind: "setup" | "teardown", planSha256: string) =>
  operate(steps, { kind, action: "verify", request: {}, planSha256 });
const gone = (fixture: ReturnType<typeof fixtureProduct>) => {
  assert.deepEqual(fixture.state.apps, []);
  assert.deepEqual(fixture.state.links, []);
  assert.deepEqual(fixture.state.accounts, []);
  assert.ok(
    fixture.state.pools.every((pool) => !pool.live),
    "only the deletion marker is left",
  );
};

test("the setup receipt names its pool and exactly two accounts, and teardown removes all of it", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* setupDry(steps);
      const applied = yield* setupApply(steps, planned);
      const pool = fixture.state.pools[0]!.app;
      const accounts = fixture.accounts.map((account) => account.id);
      const expected = {
        migration: "acceptance-pool-setup-v1",
        organization: "acceptance",
        status: "applied",
        app: pool,
        accounts,
      };
      assert.equal(accounts.length, 2);
      assert.deepEqual("receipt" in applied ? applied.receipt : undefined, expected);
      const read = yield* verify(steps, "setup", planned.planSha256);
      assert.deepEqual(
        "receipt" in read ? read.receipt : undefined,
        expected,
        "verify reads the same receipt",
      );
      assert.equal(read.action === "verify" && read.verification.checks.twoAccounts, true);

      fixture.calls.length = 0;
      const teardown = yield* teardownDry(steps, planned.planSha256);
      const removed = yield* teardownApply(steps, planned.planSha256, teardown);
      assert.equal("verification" in removed && removed.verification?.ok, true);
      assert.deepEqual(fixture.calls, [
        "unlink",
        "unlink",
        "disconnect",
        "disconnect",
        "removeApp",
        "removeApp",
        "disconnect",
      ]);
      gone(fixture);
      const checked = yield* verify(steps, "teardown", teardown.planSha256);
      assert.equal(checked.action === "verify" && checked.verification.ok, true);
      assert.deepEqual("receipt" in checked ? checked.receipt : undefined, {
        migration: "acceptance-pool-teardown-v1",
        organization: "acceptance",
        status: "applied",
        app: pool,
        accounts,
      });
      // A verified setup no longer verifies once its pool is gone.
      const stale = yield* verify(steps, "setup", planned.planSha256);
      assert.equal(stale.action === "verify" && stale.verification.ok, false);
    }),
  ));

test("a delete is refused while a link exists that the operation did not record", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* setupDry(steps);
      yield* setupApply(steps, planned);
      const pool = fixture.state.pools[0]!.app;
      const foreign = { app: pool, requirement: "custom", account: "acc_someone_else" };
      fixture.state.links.push(foreign);
      assert.equal(
        refusal(yield* Effect.flip(teardownDry(steps, planned.planSha256))),
        "unrecorded_link",
      );
      fixture.state.links.pop();
      // A link that appears after the plan refuses its first apply before anything is removed.
      const teardown = yield* teardownDry(steps, planned.planSha256);
      fixture.state.links.push(foreign);
      fixture.calls.length = 0;
      assert.equal(
        refusal(yield* Effect.flip(teardownApply(steps, planned.planSha256, teardown))),
        "unrecorded_link",
      );
      assert.deepEqual(fixture.calls, []);
      // One that appears while the teardown runs stops it before the pool is removed.
      fixture.state.links.pop();
      const base = steps;
      const racing: AcceptancePoolSteps = {
        ...base,
        run: (step, context) =>
          Effect.tap(base.run(step, context), () =>
            Effect.sync(() => {
              if (step === "disconnect:b") fixture.state.links.push(foreign);
            }),
          ),
      };
      const fresh = yield* teardownDry(steps, planned.planSha256);
      const stopped = yield* Effect.flip(teardownApply(racing, planned.planSha256, fresh));
      assert.equal(refusal(stopped), "unrecorded_link");
      assert.ok(
        fixture.state.apps.some((app) => app.id === pool),
        "the pool is not removed",
      );
    }),
  ));

test("teardown removes what a setup left when it stopped before recording a step", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      // The pool was created, but its reply was lost and the setup never resumed.
      const early = fixtureProduct({ failAfter: new Set(["createPool"]) });
      const steps = makeAcceptancePoolSteps(early.product);
      const planned = yield* setupDry(steps);
      assert.equal(refusal(yield* Effect.flip(setupApply(steps, planned))), "step_failed");
      assert.equal(early.state.pools.length, 1);
      const teardown = yield* teardownDry(steps, planned.planSha256);
      assert.equal(teardown.steps, 6, "unlink and disconnect a and b, remove the pool, its token");
      const removed = yield* teardownApply(steps, planned.planSha256, teardown);
      assert.equal("verification" in removed && removed.verification?.ok, true);
      gone(early);

      // The provider and the first account exist; the second account was never made.
      const middle = fixtureProduct({ failAfter: new Set(["link"]) });
      const middleSteps = makeAcceptancePoolSteps(middle.product);
      const middlePlan = yield* setupDry(middleSteps);
      assert.equal(refusal(yield* Effect.flip(setupApply(middleSteps, middlePlan))), "step_failed");
      assert.equal(middle.accounts.length, 1);
      const middleTeardown = yield* teardownDry(middleSteps, middlePlan.planSha256);
      yield* teardownApply(middleSteps, middlePlan.planSha256, middleTeardown);
      gone(middle);
    }),
  ));

test("teardown refuses an account, app or audience the setup did not create", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const shapes = [
        [
          "an account",
          "unrecorded_account",
          (f: ReturnType<typeof fixtureProduct>) => f.state.accounts.push("acc_other"),
        ],
        [
          "an app",
          "unrecorded_app",
          (f: ReturnType<typeof fixtureProduct>) =>
            f.state.apps.push({ id: "app_other", name: "Other" }),
        ],
        [
          "a shared pool",
          "pool_state",
          (f: ReturnType<typeof fixtureProduct>) => {
            f.state.access[0] = { ...f.state.access[0]!, audience: "everyone" };
          },
        ],
        [
          "a pool in a group",
          "pool_state",
          (f: ReturnType<typeof fixtureProduct>) => {
            f.state.access[0] = { ...f.state.access[0]!, groups: 1 };
          },
        ],
      ] as const;
      for (const [shape, reason, change] of shapes) {
        const fixture = fixtureProduct();
        const steps = makeAcceptancePoolSteps(fixture.product);
        const planned = yield* setupDry(steps);
        yield* setupApply(steps, planned);
        change(fixture);
        fixture.calls.length = 0;
        assert.equal(
          refusal(yield* Effect.flip(teardownDry(steps, planned.planSha256))),
          reason,
          shape,
        );
        assert.deepEqual(fixture.calls, [], `${shape}: nothing removed`);
      }
    }),
  ));

test("an interrupted teardown resumes, and a replayed teardown repeats nothing", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* setupDry(steps);
      yield* setupApply(steps, planned);
      const teardown = yield* teardownDry(steps, planned.planSha256);
      fixture.calls.length = 0;
      const flaky: AcceptancePoolSteps = {
        ...steps,
        run: (step, context) =>
          step === "remove-pool" && !fixture.calls.includes("lost")
            ? Effect.andThen(
                steps.run(step, context),
                Effect.sync(() => fixture.calls.push("lost")).pipe(
                  Effect.andThen(Effect.fail(new Error("reply lost"))),
                ),
              )
            : steps.run(step, context),
      };
      assert.equal(
        refusal(yield* Effect.flip(teardownApply(flaky, planned.planSha256, teardown))),
        "step_failed",
      );
      const resumed = yield* teardownApply(flaky, planned.planSha256, teardown);
      assert.equal("resumed" in resumed && resumed.resumed, true);
      assert.equal(
        fixture.calls.filter((call) => call === "removeApp").length,
        2,
        "each app removed once",
      );
      gone(fixture);
      const again = yield* teardownApply(steps, planned.planSha256, teardown);
      assert.equal("repeated" in again && again.repeated, true);
      assert.equal(fixture.calls.filter((call) => call === "removeApp").length, 2);
    }),
  ));

test("teardown refuses a pool record that is not the setup's, another live pool, or a provider it did not record", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const shapes = [
        [
          "a record with another owner",
          "pool_state",
          (f: ReturnType<typeof fixtureProduct>) => {
            f.state.pools[0] = { ...f.state.pools[0]!, owner: "someone" };
          },
        ],
        [
          "another live pool",
          "unrecorded_app",
          (f: ReturnType<typeof fixtureProduct>) => {
            f.state.pools.push({ ...f.state.pools[0]!, app: "app_other_pool", request: "other" });
          },
        ],
        [
          "a provider it did not record",
          "unrecorded_app",
          (f: ReturnType<typeof fixtureProduct>) => {
            const index = f.state.apps.findIndex((app) => app.name === "Custom endpoint");
            f.state.apps[index] = { id: "app_other_custom", name: "Custom endpoint" };
          },
        ],
      ] as const;
      for (const [shape, reason, change] of shapes) {
        const fixture = fixtureProduct();
        const steps = makeAcceptancePoolSteps(fixture.product);
        const planned = yield* setupDry(steps);
        yield* setupApply(steps, planned);
        change(fixture);
        fixture.calls.length = 0;
        assert.equal(
          refusal(yield* Effect.flip(teardownDry(steps, planned.planSha256))),
          reason,
          shape,
        );
        assert.deepEqual(fixture.calls, [], `${shape}: nothing removed`);
      }
    }),
  ));

test("a link that appears on the provider app while the teardown runs stops it before the provider is removed", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* setupDry(steps);
      yield* setupApply(steps, planned);
      const provider = fixture.state.apps.find((app) => app.name === "Custom endpoint")!.id;
      const racing: AcceptancePoolSteps = {
        ...steps,
        run: (step, context) =>
          Effect.tap(steps.run(step, context), () =>
            Effect.sync(() => {
              if (step === "disconnect:b")
                fixture.state.links.push({
                  app: provider,
                  requirement: "custom",
                  account: "acc_other",
                });
            }),
          ),
      };
      const teardown = yield* teardownDry(steps, planned.planSha256);
      assert.equal(
        refusal(yield* Effect.flip(teardownApply(racing, planned.planSha256, teardown))),
        "unrecorded_link",
      );
      assert.ok(
        fixture.state.apps.some((app) => app.id === provider),
        "the provider is not removed",
      );
    }),
  ));

test("a teardown stopped before its last step leaves the organization closed to a new setup until it finishes", () =>
  run(
    Effect.gen(function* () {
      yield* operationSchema;
      const fixture = fixtureProduct();
      const steps = makeAcceptancePoolSteps(fixture.product);
      const planned = yield* setupDry(steps);
      yield* setupApply(steps, planned);
      let stopped = false;
      const stopping: AcceptancePoolSteps = {
        ...steps,
        run: (step, context) => {
          if (step === "disconnect-token" && !stopped) {
            stopped = true;
            return Effect.fail(new Error("stopped before the token"));
          }
          return steps.run(step, context);
        },
      };
      const teardown = yield* teardownDry(steps, planned.planSha256);
      assert.equal(
        refusal(yield* Effect.flip(teardownApply(stopping, planned.planSha256, teardown))),
        "step_failed",
      );
      assert.deepEqual(fixture.state.apps, []);
      assert.equal(fixture.state.accounts.length, 1, "only the pool's token account is left");
      const unfinished = yield* verify(steps, "teardown", teardown.planSha256);
      assert.equal(
        unfinished.action === "verify" && unfinished.verification.checks.organizationEmpty,
        false,
      );
      // No new pool can start beside the leftover.
      assert.equal(refusal(yield* Effect.flip(setupDry(steps))), "unrecorded_account");
      const finished = yield* teardownApply(stopping, planned.planSha256, teardown);
      assert.equal(
        "verification" in finished && finished.verification?.checks.organizationEmpty,
        true,
      );
      gone(fixture);
      yield* setupDry(steps);
    }),
  ));
