import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../../scripts/pool-tests/runtime-fleet-worker.ts";

for (const plainObservationToken of [false, true])
  test(`STAGE-ONLY OVERLAY: provider-observe answers through the real controller with a ${plainObservationToken ? "plain secret" : "store binding"}`, async (context) => {
    const f = await fleetWorkerFixture({ candidateColor: "green", plainObservationToken });
    context.after(f.cleanup);
    const app = f.applications[1]!;
    // `send` asserts the 200 and returns the command's result.
    const result = (await f.send("provider-observe", {
      target: {
        accountId: app.accountId,
        applicationId: app.applicationId,
        namespaceId: app.namespaceId,
        applicationVersion: app.applicationVersion,
        imageDigest: app.imageDigest,
        applicationConfigDigest: app.applicationConfigDigest,
      },
    } as never)) as { credentialBinding?: string; proof?: { applicationId?: string } };
    assert.equal(result.credentialBinding, "POOL_PROVIDER_OBSERVATION_TOKEN");
    assert.equal(result.proof?.applicationId, app.applicationId);
  });
