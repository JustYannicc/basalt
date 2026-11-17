import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  explicitReleaseTarget,
  productionRelease,
  rehearsalDrainCap,
  rehearsalStop,
  releaseEntryTarget,
  releaseTarget,
  stackNameForStage,
} from "./release-stage.ts";
import { decodeRuntimeHandoffManifest } from "./runtime-slot-manifest.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { decodeProvisioningManifest } from "./provisioning-contract.ts";
import { stopAfterAdopt, timeRehearsalWait } from "./release-rehearsal-observer.ts";

const rehearsal = "test-rehearsal-42";
const original = process.env.ALCHEMY_STAGE;
afterEach(() => {
  if (original === undefined) delete process.env.ALCHEMY_STAGE;
  else process.env.ALCHEMY_STAGE = original;
});

const refusal = (reason: string) => (error: unknown) =>
  (error as { reason?: string }).reason === reason;

test("production is the default and a rehearsal has its own stage and stack", () => {
  assert.deepEqual(releaseTarget({}), productionRelease);
  assert.deepEqual(releaseTarget({ ALCHEMY_STAGE: "production" }), productionRelease);
  assert.deepEqual(releaseTarget({ ALCHEMY_STAGE: rehearsal }), {
    stack: "basalt-rehearsal",
    stage: rehearsal,
    rehearsal: true,
  });
  assert.equal(stackNameForStage(rehearsal), "basalt-rehearsal");
  assert.equal(stackNameForStage("production"), "basalt");
  assert.equal(stackNameForStage("test-pr-12"), "basalt");
});

test("every other stage refuses, and mutating entries refuse an unset stage", () => {
  for (const stage of ["staging", "test-pr-3", "rehearsal-1", "test-rehearsal-0", "Production", ""])
    assert.throws(() => releaseTarget({ ALCHEMY_STAGE: stage }), refusal("release-stage-unknown"));
  assert.throws(() => explicitReleaseTarget({}), refusal("release-stage-unknown"));
  assert.throws(() => releaseEntryTarget({}), refusal("release-stage-unknown"));
});

test("a production handoff manifest is refused on a rehearsal stage, and the reverse", async () => {
  delete process.env.ALCHEMY_STAGE;
  const { manifest } = await runtimeProofFixture();
  assert.equal(decodeRuntimeHandoffManifest(manifest).stage, "production");

  process.env.ALCHEMY_STAGE = rehearsal;
  assert.throws(() => decodeRuntimeHandoffManifest(manifest));
  const rehearsed = decodeRuntimeHandoffManifest({ ...manifest, stage: rehearsal });
  assert.equal(rehearsed.stage, rehearsal);

  process.env.ALCHEMY_STAGE = "production";
  assert.throws(() => decodeRuntimeHandoffManifest(rehearsed));
  assert.throws(() => decodeRuntimeHandoffManifest({ ...manifest, stage: "test-rehearsal-43" }));
});

test("a provisioning manifest is bound to the stage that recorded it", () => {
  delete process.env.ALCHEMY_STAGE;
  const { manifest } = provisioningFixture();
  process.env.ALCHEMY_STAGE = rehearsal;
  assert.throws(() => decodeProvisioningManifest(manifest));
  const rehearsed = decodeProvisioningManifest({ ...manifest, stage: rehearsal });
  process.env.ALCHEMY_STAGE = "production";
  assert.throws(() => decodeProvisioningManifest(rehearsed));
});

const inspected = { count: 0 };
const inspector = {
  inspect: async () => {
    inspected.count += 1;
    return { selection: { expectedEpoch: 1 }, policies: [{ pool: "clean", dirty: false }] };
  },
};

test("rehearsal controls refuse on production instead of being ignored", async () => {
  const production = { ALCHEMY_STAGE: "production" };
  for (const env of [
    { ...production, BASALT_REHEARSAL_STOP: "after-adopt" },
    { BASALT_REHEARSAL_STOP: "after-adopt" },
  ]) {
    assert.throws(() => rehearsalStop(env), refusal("release-rehearsal-stop-on-production"));
    await assert.rejects(stopAfterAdopt(inspector, "unused", env), refusal("release-rehearsal-stop-on-production"));
  }
  assert.throws(
    () => releaseEntryTarget({ ...production, BASALT_REHEARSAL_STOP: "after-adopt" }),
    refusal("release-rehearsal-stop-on-production"),
  );
  assert.throws(
    () => releaseEntryTarget({ ...production, BASALT_REHEARSAL_DRAIN_CAP_MS: "60000" }),
    refusal("release-rehearsal-drain-cap-on-production"),
  );
  assert.equal(rehearsalStop(production), undefined);
  assert.equal(rehearsalDrainCap(production), undefined);
  await stopAfterAdopt(inspector, "unused", production);
  assert.equal(inspected.count, 0, "production never reads the controller for a rehearsal stop");
});

test("a rehearsal stops after adopt only when asked, and caps the drain within bounds", async () => {
  const env = { ALCHEMY_STAGE: rehearsal };
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "basalt-rehearsal-stop-"));
  try {
    await stopAfterAdopt(inspector, directory, env);
    assert.equal(inspected.count, 0);
    await assert.rejects(
      stopAfterAdopt(inspector, directory, { ...env, BASALT_REHEARSAL_STOP: "after-adopt" }),
      refusal("release-rehearsal-stopped-after-adopt"),
    );
    assert.deepEqual(JSON.parse(await readFile(join(directory, "rehearsal-adopted.json"), "utf8")), {
      selection: { expectedEpoch: 1 },
      policies: [{ pool: "clean", dirty: false }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(
    () => rehearsalStop({ ...env, BASALT_REHEARSAL_STOP: "after-promote" }),
    refusal("release-rehearsal-stop-unknown"),
  );
  assert.equal(rehearsalDrainCap({ ...env, BASALT_REHEARSAL_DRAIN_CAP_MS: "90000" }), 90_000);
  for (const value of ["999", "abc", "-5", "1800001", "0900"])
    assert.throws(
      () => rehearsalDrainCap({ ...env, BASALT_REHEARSAL_DRAIN_CAP_MS: value }),
      refusal("release-rehearsal-drain-cap-invalid"),
    );
});

test("only a rehearsal records how long it waited", async (t) => {
  const directory = t.name.replace(/\W+/g, "-");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), `basalt-${directory}-`));
  try {
    let clock = 1_000;
    const now = () => clock;
    const waited = await timeRehearsalWait(
      root,
      "old-generation-drain",
      async () => {
        clock += 61_000;
        return "drained";
      },
      { ALCHEMY_STAGE: rehearsal },
      now,
    );
    assert.equal(waited, "drained");
    await assert.rejects(
      timeRehearsalWait(
        root,
        "image-capacity",
        async () => {
          clock += 5_000;
          throw new Error("deadline");
        },
        { ALCHEMY_STAGE: rehearsal },
        now,
      ),
    );
    const lines = (await readFile(join(root, "rehearsal-waits.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { name: "old-generation-drain", outcome: "observed", milliseconds: 61_000 },
      { name: "image-capacity", outcome: "refused", milliseconds: 5_000 },
    ]);
    await timeRehearsalWait(root, "production", async () => 1, { ALCHEMY_STAGE: "production" });
    assert.equal((await readFile(join(root, "rehearsal-waits.jsonl"), "utf8")).split("\n").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("after promote a rehearsal refuses unless the fleet permission names the serving color", async () => {
  const { assertRehearsalFleetActive } = await import("./release-rehearsal-observer.ts");
  const applications = [
    { color: "blue", applicationId: "blue-app" },
    { color: "green", applicationId: "green-app" },
  ];
  const client = (active: string, serving: string | undefined, permission = true) => ({
    fleet: async () => ({ permission: permission ? { configuration: { active, applications } } : undefined }),
    inspect: async () => ({ selection: serving ? { active: { target: { applicationId: serving } } } : undefined }),
  });
  const env = { ALCHEMY_STAGE: rehearsal };
  await assertRehearsalFleetActive(client("green", "green-app"), env);
  for (const [active, serving, permission] of [
    ["blue", "green-app", true],
    ["green", "legacy-root", true],
    ["green", undefined, true],
    ["green", "green-app", false],
  ] as const)
    await assert.rejects(
      assertRehearsalFleetActive(client(active, serving, permission), env),
      refusal("release-rehearsal-fleet-active-mismatch"),
    );
  await assertRehearsalFleetActive(client("blue", "green-app"), { ALCHEMY_STAGE: "production" });
});

test("only a rehearsal stage admits its stage's sign-in seed and pool budget commands", async () => {
  const { commandPhase, supportedCommand } = await import("./commands.ts");
  const seed = { command: "node seed.ts", memo: false };
  delete process.env.ALCHEMY_STAGE;
  assert.equal(supportedCommand("PreviewAuthSeed"), false);
  assert.equal(supportedCommand("PreviewPoolSize"), false);
  assert.throws(() => commandPhase("PreviewAuthSeed", seed), refusal("unsupported-command"));
  process.env.ALCHEMY_STAGE = rehearsal;
  assert.equal(supportedCommand("PreviewAuthSeed"), true);
  assert.equal(commandPhase("PreviewAuthSeed", seed), "database");
  assert.equal(commandPhase("PreviewPoolSize", { command: "node scripts/database-pool-budget.ts" }), "database");
  assert.throws(() => commandPhase("PreviewAuthSeed", { command: "node other.ts" }), refusal("unsupported-command"));
  assert.equal(commandPhase("Migrations", { command: "node src/migrate.ts" }), "database");
});
