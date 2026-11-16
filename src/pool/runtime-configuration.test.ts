import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationDigest,
  openConfiguration,
  runtimeConfiguration,
  sealConfiguration,
  startupOptionsFingerprint,
  runtimeStartOptions,
} from "./runtime-slots/configuration.ts";

test("admitted runtime configuration survives a controller settings change without exposing secrets", async () => {
  const original = runtimeConfiguration({
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/old",
    POOL_MANAGEMENT_KEY: "fixture-old-key",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
  });
  const sealed = await sealConfiguration(original, "b".repeat(64), "exact-target");
  assert.ok(!JSON.stringify(sealed).includes(original.databaseUrl));
  assert.ok(!JSON.stringify(sealed).includes(original.managementKey));
  const changed = { ...original, managementKey: "fixture-new-key", imageInput: "2".repeat(16) };
  assert.notEqual(await configurationDigest(original), await configurationDigest(changed));
  assert.deepEqual(await openConfiguration(sealed, "b".repeat(64), "exact-target"), original);
});

test("a retained startup capsule cannot be moved to another runtime or opened under a new key", async () => {
  const configuration = runtimeConfiguration({
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-key",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
  });
  const sealed = await sealConfiguration(configuration, "b".repeat(64), "first-target");
  await assert.rejects(openConfiguration(sealed, "b".repeat(64), "different-target"));
  await assert.rejects(openConfiguration(sealed, "c".repeat(64), "first-target"));
  const ciphertext = Buffer.from(sealed.ciphertext, "hex");
  ciphertext[0] = ciphertext[0]! ^ 0x01;
  const modified = { ...sealed, ciphertext: ciphertext.toString("hex") };
  assert.notEqual(modified.ciphertext, sealed.ciphertext);
  await assert.rejects(openConfiguration(modified, "b".repeat(64), "first-target"));
});

test("startup fingerprint binds every applied setting while launch credentials and OCI identity stay separate", async () => {
  const configuration = runtimeConfiguration({
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-key",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
  });
  const options = runtimeStartOptions(configuration),
    expected = await configurationDigest(configuration);
  assert.equal(
    await startupOptionsFingerprint({
      ...options,
      env: Object.fromEntries(Object.entries(options.env).reverse()),
    }),
    expected,
  );
  assert.equal(
    await startupOptionsFingerprint({
      ...options,
      env: { ...options.env, POOL_LAUNCH_GENERATION: "2", POOL_LAUNCH_TOKEN: "fixture-token" },
    }),
    expected,
  );
  assert.notEqual(await startupOptionsFingerprint({ ...options, enableInternet: false }), expected);
  assert.notEqual(
    await startupOptionsFingerprint({
      ...options,
      env: { ...options.env, EXTRA_START_FLAG: "changed" },
    }),
    expected,
  );
  assert.equal(
    await configurationDigest({ ...configuration, imageInput: "2".repeat(16) }),
    expected,
  );
});

test("Claude shape discovery is opt-in and bound to the admitted startup configuration", async () => {
  const env = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-key",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
  };
  const normal = runtimeConfiguration(env);
  assert.equal(runtimeStartOptions(normal).env.POOL_CLAUDE_QUOTA_DIAGNOSTIC, undefined);
  const discovery = runtimeConfiguration({ ...env, POOL_CLAUDE_QUOTA_DIAGNOSTIC: "true" });
  assert.equal(runtimeStartOptions(discovery).env.POOL_CLAUDE_QUOTA_DIAGNOSTIC, "true");
  assert.notEqual(await configurationDigest(discovery), await configurationDigest(normal));
  const retained = await openConfiguration(
    await sealConfiguration(discovery, "b".repeat(64), "discovery-target"),
    "b".repeat(64),
    "discovery-target",
  );
  assert.equal(runtimeStartOptions(retained).env.POOL_CLAUDE_QUOTA_DIAGNOSTIC, "true");
  assert.equal(
    runtimeConfiguration({ ...env, POOL_CLAUDE_QUOTA_DIAGNOSTIC: "false" }).claudeQuotaDiagnostic,
    undefined,
  );
});

test("the Home ordinal is sealed and bound to the applied startup fingerprint", async () => {
  const environment = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-key",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
  };
  const legacy = runtimeConfiguration(environment);
  const first = runtimeConfiguration({ ...environment, POOL_HOME_PEER_ORDINAL: "1" });
  const second = runtimeConfiguration({ ...environment, POOL_HOME_PEER_ORDINAL: "2" });
  assert.notEqual(await configurationDigest(legacy), await configurationDigest(first));
  assert.notEqual(await configurationDigest(first), await configurationDigest(second));
  const sealed = await sealConfiguration(first, "b".repeat(64), "fleet-first");
  const retained = await openConfiguration(sealed, "b".repeat(64), "fleet-first");
  assert.equal(runtimeStartOptions(retained).env.POOL_HOME_PEER_ORDINAL, "1");
  assert.equal(runtimeStartOptions(legacy).env.POOL_HOME_PEER_ORDINAL, undefined);
  for (const value of ["0", "129", "NaN", "1.5"])
    assert.throws(() => runtimeConfiguration({ ...environment, POOL_HOME_PEER_ORDINAL: value }));
});
