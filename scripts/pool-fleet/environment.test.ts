import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { openEnvelope, verifyPoolToken } from "../../src/pool/token.ts";
import { acceptanceFromEnvironment, dependenciesFromEnvironment } from "./environment.ts";
import { FleetLaneRefused } from "./errors.ts";

const signingKey = "ab".repeat(32);
// An acceptance-named pool id: the old rule minted an owner token for it, the new one never does.
const device = {
  computer: "computer-5d1e",
  grant: "native:grant-8a2c",
  user: "person-3f9b",
  pool: "acceptance-run-7",
};
const testDevice = {
  computer: "computer-9b04",
  grant: "native:acceptance-test-41f6",
  user: "acceptance",
  pool: "app_acceptance0load1",
  owner: "acceptance",
  organization: "acceptance",
};
/** `null` leaves the device out of the environment. */
const environment = (value: object | null = device, extra: Record<string, string> = {}) => ({
  CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
  POOL_APP_SIGNING_KEY: signingKey,
  ...(value ? { POOL_ACCEPTANCE_DEVICE: JSON.stringify(value) } : {}),
  ...extra,
});
const testRun = (value: object | null = testDevice, extra: Record<string, string> = {}) =>
  environment(null, {
    POOL_FLEET_DEVICE: "test",
    ...(value ? { POOL_ACCEPTANCE_TEST_DEVICE: JSON.stringify(value) } : {}),
    ...extra,
  });
const recordMints = () => {
  const minted: { pool: string; owner: string; organization: string; exp?: number }[] = [];
  const mint = async (
    _key: string,
    claims: { pool: string; owner: string; organization: string; exp?: number },
  ) => {
    minted.push(claims);
    return "pool-token";
  };
  return { minted, mint: mint as never };
};
/** The ids a credential signs for, from one of its assertions. */
const signedFor = async (
  credential: (method: string, path: string) => Promise<Record<string, string>>,
) => {
  const headers = await credential("POST", "/v1/chat/completions");
  assert.deepEqual(Object.keys(headers), [nativeModelHeader], "only the assertion, never a bearer");
  const { computer, grant, user, pool } = (await openEnvelope(
    signingKey,
    nativeModelPrefix,
    headers[nativeModelHeader]!,
  )) as Record<string, string>;
  return { computer, grant, user, pool };
};

test("the release's device signs each model call and never gets an owner token, whatever its pool", async () => {
  const { minted, mint } = recordMints();
  for (const value of [device, { ...device, pool: "pool-of-a-person" }]) {
    const acceptance = await acceptanceFromEnvironment(environment(value), mint);
    assert.ok(!(acceptance instanceof FleetLaneRefused), String(acceptance));
    assert.equal(acceptance.device, "release");
    assert.equal("access" in acceptance, false, "no owner access at all, not a dummy");
    const { computer, grant, user, pool } = value;
    assert.deepEqual(await signedFor(acceptance.credential), { computer, grant, user, pool });
  }
  // The pool id's prefix no longer decides anything: nothing was minted for acceptance-run-7.
  assert.deepEqual(minted, []);
  // The default choice is the release's device; an explicit one is the same.
  const explicit = await acceptanceFromEnvironment(
    environment(device, { POOL_FLEET_DEVICE: "release" }),
    mint,
  );
  assert.ok(!(explicit instanceof FleetLaneRefused) && explicit.device === "release");

  // A stored key alone gives the lane nothing to sign with.
  const stored = await dependenciesFromEnvironment({
    ...environment(null),
    POOL_ACCEPTANCE_KEY: "home-key-fixture",
    POOL_ACCEPTANCE_POOL: device.pool,
  });
  assert.ok(stored.acceptance instanceof FleetLaneRefused);
  assert.match(
    stored.acceptance.message,
    /^acceptance-credentials-missing: POOL_ACCEPTANCE_DEVICE: unset\. Fix: set the POOL_ACCEPTANCE_DEVICE secret/u,
  );
});

test("the test device of the acceptance identity signs for the test pool and gets its owner token", async () => {
  const { minted, mint } = recordMints();
  const acceptance = await acceptanceFromEnvironment(testRun(), mint, () => 1_000_000);
  assert.ok(!(acceptance instanceof FleetLaneRefused), String(acceptance));
  assert.equal(acceptance.device, "test");
  const { computer, grant, user, pool } = testDevice;
  assert.deepEqual(await signedFor(acceptance.credential), { computer, grant, user, pool });
  // Minted once, for exactly the pool the test device's secret names, and only for the job's span.
  assert.deepEqual(minted, [
    { pool, owner: "acceptance", organization: "acceptance", exp: 1_000 + 35 * 60 },
  ]);
  assert.deepEqual(acceptance.access, { token: "pool-token", owner: "acceptance" });
  // With the real signer the token names that pool, and is no longer valid once it has expired.
  const real = await acceptanceFromEnvironment(testRun());
  assert.ok(!(real instanceof FleetLaneRefused) && real.access);
  assert.equal((await verifyPoolToken(signingKey, real.access.token))?.pool, pool);
  const old = await acceptanceFromEnvironment(testRun(), undefined, () => Date.now() - 36 * 60_000);
  assert.ok(!(old instanceof FleetLaneRefused) && old.access);
  assert.equal(await verifyPoolToken(signingKey, old.access.token), undefined);
});

test("a test device of any other identity proves usage by its own read alone and mints nothing", async () => {
  const { minted, mint } = recordMints();
  for (const field of ["user", "owner", "organization"] as const) {
    const acceptance = await acceptanceFromEnvironment(
      testRun({ ...testDevice, [field]: "person-3f9b" }),
      mint,
    );
    assert.ok(!(acceptance instanceof FleetLaneRefused), String(acceptance));
    assert.equal(acceptance.device, "test", field);
    assert.equal("access" in acceptance, false, field);
  }
  assert.deepEqual(minted, []);
});

test("with both secrets set, each choice signs for its own device", async () => {
  const both = { ...environment(device), POOL_ACCEPTANCE_TEST_DEVICE: JSON.stringify(testDevice) };
  const { mint } = recordMints();
  for (const [choice, expected] of [
    ["release", device],
    ["test", testDevice],
  ] as const) {
    const acceptance = await acceptanceFromEnvironment(
      { ...both, POOL_FLEET_DEVICE: choice },
      mint,
    );
    assert.ok(!(acceptance instanceof FleetLaneRefused), String(acceptance));
    const { computer, grant, user, pool } = expected;
    assert.deepEqual(
      await signedFor(acceptance.credential),
      { computer, grant, user, pool },
      choice,
    );
  }
});

test("neither device ever stands in for the other, and an unknown choice is refused", async () => {
  const { minted, mint } = recordMints();
  // Test chosen, only the release's device set: refused by the test secret's name.
  const noTest = await acceptanceFromEnvironment(
    { ...environment(device), POOL_FLEET_DEVICE: "test" },
    mint,
  );
  assert.ok(noTest instanceof FleetLaneRefused);
  assert.match(
    noTest.message,
    /^acceptance-credentials-missing: POOL_ACCEPTANCE_TEST_DEVICE: unset\./u,
  );
  // Release chosen, only the test device set: refused by the release secret's name.
  const noRelease = await acceptanceFromEnvironment(
    { ...testRun(), POOL_FLEET_DEVICE: "release" },
    mint,
  );
  assert.ok(noRelease instanceof FleetLaneRefused);
  assert.match(
    noRelease.message,
    /^acceptance-credentials-missing: POOL_ACCEPTANCE_DEVICE: unset\./u,
  );
  // A test device without its pool's owner and organization is malformed, and names no id.
  const { owner: _owner, ...withoutOwner } = testDevice;
  const malformed = await acceptanceFromEnvironment(testRun(withoutOwner), mint);
  assert.ok(malformed instanceof FleetLaneRefused);
  assert.match(malformed.message, /POOL_ACCEPTANCE_TEST_DEVICE: malformed\./u);
  for (const refused of [noTest, noRelease, malformed])
    for (const id of [...Object.values(device), ...Object.values(testDevice)].filter(
      (id) => id !== "acceptance",
    ))
      assert.ok(!refused.message.includes(id), `${id} in ${refused.message}`);
  const unknown = await acceptanceFromEnvironment(
    { ...environment(device), POOL_FLEET_DEVICE: "both" },
    mint,
  );
  assert.ok(unknown instanceof FleetLaneRefused);
  assert.equal(unknown.reason, "acceptance-device-invalid");
  assert.deepEqual(minted, []);
});

test("the fleet workflow passes each run only the device it chose, as secrets, and no stored model key", async () => {
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = await readFile(
    new URL("../../.github/workflows/pool-fleet.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /POOL_ACCEPTANCE_KEY|POOL_ACCEPTANCE_POOL/u);
  const parsed = parse(workflow) as {
    on: { workflow_dispatch: { inputs: Record<string, { default?: string; options?: string[] }> } };
    jobs: { fleet: { steps: { name?: string; env?: object }[] } };
  };
  const input = parsed.on.workflow_dispatch.inputs.device;
  assert.deepEqual(
    { default: input?.default, options: input?.options },
    {
      default: "release",
      options: ["release", "test"],
    },
  );
  const lane = parsed.jobs.fleet.steps.find((step) => step.name === "Run the fleet lane");
  const env = lane?.env as Record<string, string> | undefined;
  // Secrets, not variables: GitHub prints a step's env in its log and masks only secrets.
  assert.equal(
    env?.POOL_ACCEPTANCE_DEVICE,
    "${{ inputs.device != 'test' && secrets.POOL_ACCEPTANCE_DEVICE || '' }}",
  );
  assert.equal(
    env?.POOL_ACCEPTANCE_TEST_DEVICE,
    "${{ inputs.device == 'test' && secrets.POOL_ACCEPTANCE_TEST_DEVICE || '' }}",
  );
  assert.equal(env?.POOL_FLEET_DEVICE, "${{ inputs.device }}");
  assert.equal(env?.POOL_APP_SIGNING_KEY, "${{ secrets.POOL_APP_SIGNING_KEY }}");
  assert.equal(env?.POOL_APP_SIGNING_KEY_PREVIOUS, "${{ secrets.POOL_APP_SIGNING_KEY_PREVIOUS }}");
});
