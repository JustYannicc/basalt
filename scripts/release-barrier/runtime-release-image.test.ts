import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Schema } from "effect";
import { runtimeReleaseClientFixture } from "./test/runtime-release-client-fixture.ts";
import { containerPublication } from "./test/container-fixture.ts";
import { assertReleaseImageCapacity, runtimeReleaseImage } from "./runtime-release-image.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runtimeConfiguration } from "../../src/pool/runtime-slots/configuration.ts";
import { runtimeFixtureCode } from "../pool-tests/runtime-handoff-proofs.ts";

for (const maximum of [1, 2, 3, 4])
  test(
    `two consecutive upgrades from a non-legacy primary preflight the retained cap ${maximum}`,
    { timeout: 15_000 },
    async (context) => {
      const f = await runtimeReleaseClientFixture();
      context.after(() => f.cleanup());
      await f.client.promote("green-application", "select-initial-primary", f.claims.pool);
      await f.send("drain", { operationId: "drain-legacy-primary" });
      const previous = (await f.client.fleet()).permission!;
      await f.send("fleet-configure", {
        operationId: "retained-cap",
        configuration: {
          ...previous.configuration,
          revision: previous.configuration.revision + 1,
          previousDigest: previous.digest,
          maximum,
          targetActive: 100,
        },
      });
      const selected = (await f.client.inspect()).selection!.active;
      assert.notEqual(selected.target.instanceId, selected.target.controllerId);
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { CLOUDFLARE_API_TOKEN: "synthetic-provider-read" },
                }),
              ),
            ),
          ),
        );
      for (const [index, color] of ["blue", "green"].entries()) {
        if (maximum === 1) {
          const before = f.commands.length;
          const phase = await run(
            runtimeReleaseImage({
              resource: color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
              client: f.client,
              read: () => {
                throw new Error("Capacity preflight must precede the image mutation journal");
              },
              save: async () => {
                throw new Error("Capacity preflight cannot write image intent");
              },
            }),
          );
          await assert.rejects(
            phase.prepare({
              ...containerPublication().frozen,
              id: color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
            }),
            (error) => {
              assert.ok(error instanceof BarrierRefusal);
              assert.equal(error.reason, "runtime-release-capacity-raise-cap-required");
              assert.match(error.delta!.why![0]!, /Raise the fleet cap explicitly/);
              return true;
            },
          );
          assert.deepEqual(f.commands.slice(before).sort(), ["fleet-inspect", "inspect"]);
          assert.equal(
            (await f.client.inspect()).selection!.active.identity!.bootId,
            selected.identity!.bootId,
          );
          assert.equal(f.instances.size, 1);
        } else {
          await assertReleaseImageCapacity(f.client);
          await f.client.promote(`${color}-application`, `consecutive-${index}`, f.claims.pool);
          assert.equal(
            (await f.client.inspect()).selection!.active.target.applicationId,
            `${color}-application`,
          );
          await f.send("drain", { operationId: `drain-previous-${index}` });
        }
      }
      if (maximum === 1) assert.equal(f.commands.filter((action) => action === "stage").length, 1);
      else assert.equal(f.commands.filter((action) => action === "promote").length, 3);
    },
  );

test("a cap reduction after preflight cannot replace the permission bound to image intent", async (context) => {
  const f = await runtimeReleaseClientFixture();
  context.after(() => f.cleanup());
  await f.client.promote("green-application", "select-for-interleaving", f.claims.pool);
  await f.send("drain", { operationId: "drain-interleaving-legacy" });
  const previous = (await f.client.fleet()).permission!;
  await f.send("fleet-configure", {
    operationId: "cap-two",
    configuration: {
      ...previous.configuration,
      maximum: 2,
      revision: previous.configuration.revision + 1,
      previousDigest: previous.digest,
    },
  });
  const checked = (await f.client.fleet()).permission!;
  const selected = (await f.client.inspect()).selection!.active.identity;
  const fleet = f.client.fleet;
  let lowered = false;
  context.mock.method(f.client, "fleet", async (operationId?: string) => {
    const snapshot = await fleet(operationId);
    if (!lowered && operationId === undefined) {
      lowered = true;
      await f.send("fleet-configure", {
        operationId: "lower-cap-after-read",
        configuration: {
          ...checked.configuration,
          maximum: 1,
          revision: checked.configuration.revision + 1,
          previousDigest: checked.digest,
        },
      });
    }
    return snapshot;
  });
  let record: RuntimeReleaseRecord = {
    format: "pool-image-release-v1",
    candidate: runtimeFixtureCode.candidate,
    complete: false,
    baseline: f.state,
    desiredInput: "9".repeat(16),
    desiredConfiguration: runtimeConfiguration(f.candidate.env),
    bootstrap: {},
    configurations: {},
  };
  const phase = await Effect.runPromise(
    runtimeReleaseImage({
      resource: "PoolRuntimeBlue",
      client: f.client,
      read: () => record,
      save: async (next) => {
        record = next;
      },
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-provider-read" } }),
        ),
      ),
    ),
  );
  const blue = checked.configuration.applications.find((app) => app.color === "blue")!;
  const frozen = containerPublication().frozen;
  await assert.rejects(
    phase.prepare({
      ...frozen,
      id: "PoolRuntimeBlue",
      baseline: { ...frozen.baseline, applicationId: blue.applicationId },
    }),
    /runtime-handoff-response-refused/,
  );
  assert.equal(lowered, true);
  assert.equal(record.update!.configurationDigest, checked.digest);
  const inspected = await f.client.call({
    action: "image-inspect",
    operationId: record.update!.operationId,
  });
  assert.equal(
    Schema.decodeUnknownSync(Schema.Struct({ result: Schema.NullOr(Schema.Unknown) }))(inspected)
      .result,
    null,
  );
  assert.deepEqual((await f.client.inspect()).selection!.active.identity, selected);
  assert.equal(f.commands.filter((action) => action === "stage").length, 1);
});
