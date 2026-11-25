import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { InstanceId } from "alchemy/InstanceId";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import { stageBucketDelete } from "./stack/stage-bucket-cleanup.ts";

const instance = "ab".repeat(16);
const suffix = "vov2xk5lvov2xk5l";

/** A cleanup run's bucket delete, against a stand-in for Alchemy's own provider. */
async function destroy(
  run: { stack: string; stage: string },
  row: { id: string; bucketName: string; instanceId?: string; name?: string },
) {
  const deleted: { bucketName: string; forceDestroy: unknown }[] = [];
  const native = {
    delete: (input: { output: { bucketName: string }; olds: { forceDestroy?: unknown } }) =>
      Effect.sync(() => {
        deleted.push({
          bucketName: input.output.bucketName,
          forceDestroy: input.olds.forceDestroy,
        });
      }),
  };
  const exit = await Effect.runPromiseExit(
    stageBucketDelete(native as never)({
      id: row.id,
      instanceId: row.instanceId ?? instance,
      olds: { jurisdiction: "eu", ...(row.name ? { name: row.name } : {}) },
      output: { bucketName: row.bucketName, jurisdiction: "eu" },
    } as never).pipe(
      Effect.provideService(StackContext, { name: run.stack } as never),
      Effect.provideService(Stage, run.stage),
      Effect.provideService(InstanceId, instance),
    ),
  );
  return { exit, deleted };
}

const lane = { stack: "basalt-rehearsal", stage: "test-rehearsal-3" };

test("a stage's destroy empties and deletes each bucket Alchemy named for it", async () => {
  // Whole names, and the 63-character names Alchemy cuts past the stage and keeps a hash of.
  for (const [run, id, bucketName] of [
    [lane, "AppBuilds", `basalt-rehearsal-appbuilds-test-rehearsal-3-${suffix}`],
    [lane, "SiteAssets", `basalt-rehearsal-siteassets-test-rehearsal-3-${suffix}`],
    [lane, "VaultAttachmentsPreview", `basalt-rehearsal-vaultattachmentspreviepbtokmrb${suffix}`],
    [
      { stack: "basalt-rehearsal", stage: "test-rehearsal-1234" },
      "SiteAssets",
      `basalt-rehearsal-siteassets-test-reheark377pzob${suffix}`,
    ],
    [
      { stack: "basalt", stage: "test-pr-17" },
      "AppBuilds",
      `basalt-appbuilds-test-pr-17-${suffix}`,
    ],
  ] as const) {
    const { exit, deleted } = await destroy(run, { id, bucketName });
    assert.ok(Exit.isSuccess(exit), bucketName);
    assert.deepEqual(deleted, [{ bucketName, forceDestroy: true }]);
  }
});

test("a destroy refuses every bucket this stage did not name, production's first", async () => {
  for (const [why, run, row] of [
    [
      "production's",
      lane,
      { id: "AppBuilds", bucketName: `basalt-appbuilds-production-${suffix}` },
    ],
    [
      "production's, from a production stage",
      { stack: "basalt", stage: "production" },
      { id: "AppBuilds", bucketName: `basalt-appbuilds-production-${suffix}` },
    ],
    [
      "another lane's",
      lane,
      { id: "AppBuilds", bucketName: `basalt-rehearsal-appbuilds-test-rehearsal-4-${suffix}` },
    ],
    [
      "another lane's truncated name",
      { stack: "basalt-rehearsal", stage: "test-rehearsal-4" },
      {
        id: "VaultAttachmentsPreview",
        bucketName: `basalt-rehearsal-vaultattachmentspreviepbtokmrb${suffix}`,
      },
    ],
    [
      "another resource's",
      lane,
      { id: "SiteAssets", bucketName: `basalt-rehearsal-appbuilds-test-rehearsal-3-${suffix}` },
    ],
    [
      "another instance's",
      lane,
      {
        id: "AppBuilds",
        bucketName: `basalt-rehearsal-appbuilds-test-rehearsal-3-${suffix}`,
        instanceId: "cd".repeat(16),
      },
    ],
    [
      "one with an explicit name",
      lane,
      {
        id: "AppBuilds",
        bucketName: `basalt-rehearsal-appbuilds-test-rehearsal-3-${suffix}`,
        name: `basalt-rehearsal-appbuilds-test-rehearsal-3-${suffix}`,
      },
    ],
    [
      "upstream's preview bucket",
      lane,
      { id: "AppBuilds", bucketName: `executor-next-hosted-appbuilds-test-rehearsal-3-${suffix}` },
    ],
  ] as const) {
    const { exit, deleted } = await destroy(run, row);
    assert.ok(Exit.isFailure(exit), why);
    assert.match(
      String(Cause.squash(exit.cause)),
      /Refusing to empty a bucket this stage did not name/,
      why,
    );
    assert.deepEqual(deleted, [], why);
  }
});

test("the cleanup stack opens State under the deploy stack's own name", async () => {
  // A bucket's name is built from its stack's name, so a cleanup stack under another name would
  // refuse every bucket again, and each stage's destroy would stop where it did before.
  const { readFile } = await import("node:fs/promises");
  const stackName = async (path: string) => {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    const name = /Alchemy\.Stack\(\s*([^,]+),/u.exec(source)?.[1]?.trim();
    assert.ok(name, path);
    return name.replace("configuredStage", "process.env.ALCHEMY_STAGE");
  };
  assert.equal(
    await stackName("scripts/preview/stack/alchemy.cleanup.ts"),
    await stackName("alchemy.run.ts"),
  );
});
