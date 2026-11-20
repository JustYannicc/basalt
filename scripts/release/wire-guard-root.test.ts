import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { install, WireRefused } from "./wire-guard.ts";
import { applicationId, makePlan, productionRows } from "./test/plan-fixture.ts";

// Its own file, so its own process: the guard is installed before anything reads the global fetch,
// in the order the release entry uses. In a shared process an earlier test may have cached it.

const refusalOf = (exit: Exit.Exit<unknown, unknown>): WireRefused => {
  assert.ok(Exit.isFailure(exit), "expected a refusal");
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof WireRefused, `no wire guard refusal in ${String(error)}`);
  return error;
};
test("Alchemy's own container provider never patches the root when the guard holds it", async (t) => {
  // Settling PoolWorker applies the root container first. The fixture's declaration differs from
  // the recorded application, so the real provider sends a PATCH and a rollout: both must stop.
  const rows = productionRows();
  const worker = rows.PoolWorker as { bindings: { sid: string }[] };
  worker.bindings = worker.bindings.filter((binding) => binding.sid !== "PoolLedger");
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install({ rootApplications: [applicationId] });
        const planned = yield* Effect.exit(
          Effect.tryPromise(() =>
            makePlan(t, {
              rows,
              declared: { ledger: undefined, fleetClasses: true },
              settle: ["PoolWorker"],
              shadow: true,
            }),
          ),
        );
        const refused = yield* Effect.exit(Effect.timeout(guard.refused, "10 millis"));
        return { planned, refused, journal: [...guard.journal] };
      }),
    ),
  );
  assert.ok(Exit.isFailure(outcome.planned), "the settle must not complete");
  const refused = refusalOf(outcome.refused);
  assert.equal(refused.resource, `container application ${applicationId}`);
  assert.deepEqual([refused.field, refused.value], ["method", "PATCH"]);
  assert.ok(
    !outcome.journal.some((entry) => entry.method !== "GET" && entry.path.includes("rollouts")),
    "no rollout was sent",
  );
});
