import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { openEnvelope, verifyPoolToken } from "../../src/pool/token.ts";
import { acceptanceFromEnvironment, dependenciesFromEnvironment } from "./environment.ts";
import { FleetLaneRefused } from "./errors.ts";

const signingKey = "ab".repeat(32);
const device = {
  computer: "computer-5d1e",
  grant: "native:grant-8a2c",
  user: "person-3f9b",
  pool: "acceptance-run-7",
};
/** `null` leaves the device out of the environment. */
const environment = (value: object | null = device) => ({
  CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
  POOL_APP_SIGNING_KEY: signingKey,
  ...(value ? { POOL_ACCEPTANCE_DEVICE: JSON.stringify(value) } : {}),
});

test("the fleet lane signs each model call for the release's acceptance device, never a stored key", async () => {
  const deps = await dependenciesFromEnvironment(environment());
  assert.ok(!(deps.acceptance instanceof FleetLaneRefused), String(deps.acceptance));
  const headers = await deps.acceptance.credential("POST", "/v1/chat/completions");
  assert.deepEqual(Object.keys(headers), [nativeModelHeader], "only the assertion, never a bearer");
  assert.deepEqual(
    {
      ...((await openEnvelope(
        signingKey,
        nativeModelPrefix,
        headers[nativeModelHeader]!,
      )) as object),
      expiresAt: 0,
    },
    { ...device, method: "POST", path: "/v1/chat/completions", expiresAt: 0 },
  );
  // In a dedicated acceptance pool, usage is read in the device's own pool, so the records its
  // calls leave are the ones checked.
  assert.ok(deps.acceptance.access, "a dedicated acceptance pool keeps its owner access");
  assert.equal(
    (await verifyPoolToken(signingKey, deps.acceptance.access.token))?.pool,
    device.pool,
  );

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

test("a device outside a dedicated acceptance pool runs device-only: no owner token is ever minted", async () => {
  const minted: unknown[] = [];
  const mint = async (...args: unknown[]) => {
    minted.push(args);
    return "pool-token";
  };
  const personal = await acceptanceFromEnvironment(
    environment({ ...device, pool: "pool-of-a-person" }),
    mint,
  );
  assert.ok(!(personal instanceof FleetLaneRefused), String(personal));
  assert.equal("access" in personal, false, "no owner access at all, not a dummy");
  assert.deepEqual(minted, [], "signPoolToken is never called for a pool holding people's work");
  // The device still signs its own model calls.
  const headers = await personal.credential("POST", "/v1/chat/completions");
  assert.deepEqual(Object.keys(headers), [nativeModelHeader]);

  // A dedicated acceptance pool keeps today's owner access, minted for that pool alone.
  const dedicated = await acceptanceFromEnvironment(environment(), mint);
  assert.ok(!(dedicated instanceof FleetLaneRefused) && dedicated.access);
  assert.equal(minted.length, 1);
  assert.equal((minted[0] as [string, { pool: string }])[1].pool, device.pool);

  // A device that is missing is still refused, and names no id.
  const missing = await acceptanceFromEnvironment(environment(null), mint);
  assert.ok(missing instanceof FleetLaneRefused);
  for (const id of [...Object.values(device), "pool-of-a-person"])
    assert.ok(!missing.message.includes(id), `${id} in ${missing.message}`);
  assert.equal(minted.length, 1);
});

test("the fleet workflow passes the acceptance device as a secret and no stored model key", async () => {
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = await readFile(
    new URL("../../.github/workflows/pool-fleet.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /POOL_ACCEPTANCE_KEY|POOL_ACCEPTANCE_POOL/u);
  const lane = (
    parse(workflow) as { jobs: { fleet: { steps: { name?: string; env?: object }[] } } }
  ).jobs.fleet.steps.find((step) => step.name === "Run the fleet lane");
  const env = lane?.env as Record<string, string> | undefined;
  // A secret, not a variable: GitHub prints a step's env in its log and masks only secrets.
  assert.equal(env?.POOL_ACCEPTANCE_DEVICE, "${{ secrets.POOL_ACCEPTANCE_DEVICE }}");
  assert.equal(env?.POOL_APP_SIGNING_KEY, "${{ secrets.POOL_APP_SIGNING_KEY }}");
  assert.equal(env?.POOL_APP_SIGNING_KEY_PREVIOUS, "${{ secrets.POOL_APP_SIGNING_KEY_PREVIOUS }}");
});
