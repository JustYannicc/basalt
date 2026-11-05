import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { deferredProvisioningWake } from "../../.upstream/apps/hosted/cloud/src/infrastructure/provisioning-wake.ts";
import { workflowResults } from "../../.upstream/apps/hosted/cloud/src/infrastructure/workflow-results.ts";

for (const encrypted of [false, true])
  for (const runnable of [false, true])
    test(`provisioning wake uses a durable delay then checks runnable work: encrypted=${encrypted}, runnable=${runnable}`, async () => {
      const steps: string[] = [];
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`create table hosted_provisioning (status text, available_at timestamptz, updated_at timestamptz)`;
          yield* sql`insert into hosted_provisioning values ('queued', now() + interval '1 hour', now())`;
          const results = encrypted
            ? yield* workflowResults(
                "provisioning-wake-fixture",
                Effect.succeed(Redacted.make("31".repeat(32))),
              )
            : undefined;
          const service = Cloudflare.Workflows.WorkflowStep.of({
            do: (options) => options.effect,
            sleep: (_name, duration) =>
              Effect.gen(function* () {
                assert.equal(duration, 3_000);
                assert.deepEqual(steps, ["provision-committed"]);
                steps.push("native-alarm");
                if (runnable)
                  yield* sql`insert into hosted_provisioning values ('queued', now(), now())`;
              }),
            sleepUntil: () => Effect.die("unexpected sleepUntil"),
            waitForEvent: () => Effect.die("unexpected waitForEvent"),
          });
          steps.push("provision-committed");
          yield* deferredProvisioningWake(
            Effect.sync(() => {
              steps.push("placed-job");
            }),
            results,
          ).pipe(
            Effect.provideService(Cloudflare.Workflows.WorkflowStep, service),
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          );
          assert.deepEqual(steps, [
            "provision-committed",
            "native-alarm",
            ...(runnable ? ["placed-job"] : []),
          ]);
        }).pipe(Effect.provide(pgliteLayer())),
      );
    });
