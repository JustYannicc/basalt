import assert from "node:assert/strict";
import { test } from "node:test";
import { readReleaseTarget } from "./pool-crash-dispatch-sources.ts";
import { accountId, harness, primary, worker } from "./pool-fleet/test/harness.ts";

const env = (signingKey: string) => ({
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "fixture-token",
  POOL_DEPLOYMENT_KEY: signingKey,
});

test("the crash target comes from the Worker's tags and bindings, and the controller's selection", async () => {
  const lane = await harness();
  try {
    const target = await readReleaseTarget(env(lane.signingKey), {
      origin: lane.cloudflareOrigin,
      connect: lane.connect,
      code: lane.code,
    });
    assert.deepEqual(target, {
      accountId,
      worker,
      root: {
        applicationId: primary.applicationId,
        applicationVersion: primary.applicationVersion,
        imageDigest: primary.imageDigest,
        imageInput: primary.imageInput,
      },
    });
    assert.deepEqual(lane.actions, ["inspect"]);
  } finally {
    await lane.close();
  }
});

test("a refused signed inspect still names the root from the deployed Worker", async () => {
  const lane = await harness();
  try {
    const target = await readReleaseTarget(env(lane.signingKey), {
      origin: lane.cloudflareOrigin,
      connect: lane.connect,
      code: { ...lane.code, workerInput: "0".repeat(64) },
    });
    assert.equal(target.root.applicationVersion, "57");
    assert.equal(target.root.imageDigest, primary.imageDigest);
    assert.equal(target.root.imageInput, primary.imageInput);
  } finally {
    await lane.close();
  }
});

test("missing Cloudflare credentials refuse before any read", async () => {
  await assert.rejects(
    readReleaseTarget({ CLOUDFLARE_ACCOUNT_ID: accountId }),
    /crash-dispatch-release-state-credentials-unavailable/u,
  );
});
