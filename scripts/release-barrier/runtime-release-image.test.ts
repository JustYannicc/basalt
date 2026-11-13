import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { runtimeReleaseClientFixture } from "./test/runtime-release-client-fixture.ts";
import { containerPublication } from "./test/container-fixture.ts";
import { assertReleaseImageCapacity, runtimeReleaseImage } from "./runtime-release-image.ts";
import { BarrierRefusal } from "./refusal.ts";

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
