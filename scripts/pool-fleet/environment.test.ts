import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { dependenciesFromEnvironment } from "./environment.ts";
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

test("the lane accepts the device in the pool that holds it and holds no pool token", async () => {
  // Its usage is read with the device's own assertion, so a person's pool needs no dedicated twin.
  const deps = await dependenciesFromEnvironment(
    environment({ ...device, pool: "pool-of-a-person" }),
  );
  assert.ok(!(deps.acceptance instanceof FleetLaneRefused), String(deps.acceptance));
  assert.deepEqual(Object.keys(deps.acceptance).sort(), ["client", "credential", "model"]);
});

test("no fleet lane code mints a pool owner token", async () => {
  const directory = new URL("./", import.meta.url);
  const sources = (await readdir(directory, { recursive: true })).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("test/"),
  );
  assert.ok(sources.includes("accept.ts") && sources.includes("environment.ts"));
  for (const name of sources) {
    const source = await readFile(new URL(name, directory), "utf8");
    // The lane reads its own traffic back with the device assertion; the mint is the one way in.
    assert.ok(!/\bsignPoolToken\b/u.test(source), name);
  }
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
