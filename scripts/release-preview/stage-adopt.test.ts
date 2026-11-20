import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptScope,
  adoptTarget,
  adoptedState,
  infraOnlyShape,
  refuseRecordedAdoption,
  requiredPin,
  rootMatchesPin,
  settledProof,
} from "./stage-adopt.ts";
import { earlierSeed } from "./stage-seed.ts";
import { smokePool } from "./stage-model.ts";
import { rehearsalEmptyPoolCount, rehearsalPoolName } from "./rehearsal-seed.ts";

const image = `registry.cloudflare.com/${"0".repeat(32)}/basalt-poolcontainer@sha256:${"e".repeat(64)}`;
const pin = { image, input: "526fa60bed0df442" };

test("adoptTarget accepts a standing rehearsal stage and its own pool Worker", () => {
  assert.equal(adoptTarget("test-rehearsal-2"), "test-rehearsal-2");
  assert.equal(
    adoptTarget("test-rehearsal-2", "basalt-rehearsal-poolworker-test-rehearsal-2-abc"),
    "test-rehearsal-2",
  );
});

test("adoptTarget refuses production, previews and an unset stage", () => {
  for (const stage of ["production", "test-preview-1", "test-rehearsal-0", "", undefined])
    assert.throws(() => adoptTarget(stage), /test-rehearsal/u);
});

test("adoptTarget refuses a production pool Worker address even on a rehearsal stage", () => {
  assert.throws(
    () => adoptTarget("test-rehearsal-2", "basalt-poolworker-production-abc"),
    /not this stage's/u,
  );
  assert.throws(
    () => adoptTarget("test-rehearsal-2", "basalt-rehearsal-poolworker-test-rehearsal-21-abc"),
    /not this stage's/u,
  );
});

test("adoptedState reads production's adopted shape", () => {
  assert.deepEqual(
    adoptedState(
      {
        selection: {
          epoch: 1,
          active: {
            fenced: false,
            target: {
              slotId: "legacy",
              applicationVersion: 3,
              imageDigest: "sha256:e",
              imageInput: "526fa60bed0df442",
            },
          },
        },
      },
      true,
    ),
    {
      epoch: 1,
      slotId: "legacy",
      homePeerOrdinal: false,
      fenced: false,
      applicationVersion: 3,
      imageDigest: "sha256:e",
      imageInput: "526fa60bed0df442",
      healthy: true,
    },
  );
});

test("adoptedState reads no selection as nulls", () => {
  const state = adoptedState({ selection: null }, false);
  assert.equal(state.epoch, null);
  assert.equal(state.slotId, null);
  assert.equal(state.fenced, null);
  assert.equal(state.healthy, false);
});

test("adoptScope names the rehearsal stack and the stage it adopts on", async () => {
  assert.deepEqual(await adoptScope({ ALCHEMY_STAGE: "test-rehearsal-2" }), {
    stack: "basalt-rehearsal",
    stage: "test-rehearsal-2",
  });
});

test("adoptScope refuses production, named or unset", async () => {
  await assert.rejects(adoptScope({ ALCHEMY_STAGE: "production" }), /production/u);
  await assert.rejects(adoptScope({}), /production/u);
});

test("requiredPin refuses to adopt without the pinned image and input", () => {
  assert.throws(() => requiredPin({}), /pinned image/u);
  assert.throws(() => requiredPin({ STAGE_ADOPT_EXPECTED_INPUT: pin.input }), /pinned image/u);
  assert.throws(
    () =>
      requiredPin({
        STAGE_ADOPT_EXPECTED_IMAGE: image.replace(/@.*/u, ":latest"),
        STAGE_ADOPT_EXPECTED_INPUT: pin.input,
      }),
    /pinned image/u,
  );
  assert.deepEqual(
    requiredPin({ STAGE_ADOPT_EXPECTED_IMAGE: image, STAGE_ADOPT_EXPECTED_INPUT: pin.input }),
    pin,
  );
});

test("rootMatchesPin accepts only the pinned image and input", () => {
  assert.doesNotThrow(() => rootMatchesPin({ image, input: pin.input }, pin));
  assert.throws(
    () =>
      rootMatchesPin({ image: image.replace(/e{64}$/u, "f".repeat(64)), input: pin.input }, pin),
    /pinned digest/u,
  );
  assert.throws(
    () => rootMatchesPin({ image: undefined, input: pin.input }, pin),
    /pinned digest/u,
  );
  assert.throws(() => rootMatchesPin({ image, input: "0".repeat(16) }, pin), /image input/u);
});

test("settledProof agrees across policy order and refuses while the digest or a revision moves", () => {
  const read = (digest: string, revision: number) => ({
    digest,
    policies: [
      { pool: "app_b", revision: 1 },
      { pool: "app_a", revision },
    ],
  });
  assert.deepEqual(
    settledProof(read("d1", 2), {
      ...read("d1", 2),
      policies: [...read("d1", 2).policies].reverse(),
    }),
    {
      digest: "d1",
      revisions: [
        ["app_a", 2],
        ["app_b", 1],
      ],
    },
  );
  assert.throws(() => settledProof(read("d1", 2), read("d2", 2)), /still changing/u);
  assert.throws(() => settledProof(read("d1", 2), read("d1", 3)), /still changing/u);
});

test("existingRehearsalPools counts only the names the rehearsal seed gives its pools", async () => {
  const { existingRehearsalPools } = await import("./stage-seed.ts");
  assert.equal(existingRehearsalPools(["Preview smoke's pool", "Some app"]), 0);
  assert.equal(
    existingRehearsalPools([
      "Preview smoke's pool",
      "Rehearsal clean pool",
      "Rehearsal empty pool 1",
      "Rehearsal empty pool 5",
      "Rehearsal empty pool x",
    ]),
    3,
  );
});

test("refuseRecordedAdoption sends only when the root records no adoption", () => {
  assert.doesNotThrow(() => refuseRecordedAdoption({ result: { kind: "witness", witness: {} } }));
  assert.throws(
    () => refuseRecordedAdoption({ result: { kind: "unattested-active", authorization: {} } }),
    /already records an adoption/u,
  );
  assert.throws(() => refuseRecordedAdoption({}), /could not be read/u);
  assert.throws(() => refuseRecordedAdoption(undefined), /could not be read/u);
});

const fullSeed = () => [
  { id: "app_smoke", name: "Preview smoke's pool" },
  ...Array.from({ length: rehearsalEmptyPoolCount + 1 }, (_, index) => ({
    id: `app_${index}`,
    name: rehearsalPoolName(index),
  })),
];

test("smokePool requires exactly one smoke pool", () => {
  assert.deepEqual(smokePool(fullSeed()), { id: "app_smoke", name: "Preview smoke's pool" });
  assert.throws(() => smokePool([]), /0 smoke pools/u);
  assert.throws(
    () => smokePool([...fullSeed(), { id: "app_smoke2", name: "Preview smoke's pool 2" }]),
    /2 smoke pools/u,
  );
});

test("earlierSeed takes only a full set with one of each name", () => {
  assert.equal(
    earlierSeed([{ id: "app_smoke", name: "Preview smoke's pool" }], "app_smoke"),
    undefined,
  );
  assert.deepEqual(earlierSeed(fullSeed(), "app_smoke"), {
    cleanPool: "app_0",
    emptyPools: [
      "app_smoke",
      ...Array.from({ length: rehearsalEmptyPoolCount }, (_, index) => `app_${index + 1}`),
    ],
  });
  assert.throws(() => earlierSeed(fullSeed().slice(0, 3), "app_smoke"), /nothing was seeded/u);
  assert.throws(
    () => earlierSeed([...fullSeed(), { id: "app_dup", name: rehearsalPoolName(1) }], "app_smoke"),
    /one of each name/u,
  );
});

test("infraOnlyShape refuses any policy set but the infra-only one", async () => {
  const pools = { cleanPool: "app_0", emptyPools: ["app_smoke", "app_1"] };
  const policy = (pool: string, dirty: boolean, accounts: string[] = []) => ({
    pool,
    organization: "org_a",
    revision: 1,
    expiresAt: 0,
    accounts,
    dirty,
  });
  // A short pool set: the verifier's own count is the production shape's, so this refuses too.
  await assert.rejects(
    infraOnlyShape({ policies: [policy("app_0", false), policy("app_smoke", true)] }, pools),
  );
  await assert.rejects(infraOnlyShape({ policies: [] }, pools));
  await assert.rejects(
    infraOnlyShape({ policies: [policy("app_0", false, ["auth-a"])] }, pools),
    /infra-only clean pool has accounts|expected/u,
  );
});
