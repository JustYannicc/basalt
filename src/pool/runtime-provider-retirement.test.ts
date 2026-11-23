import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeProofFixture } from "../../scripts/pool-fleet/test/runtime-proof-fixture.ts";
import { runtimeApplicationConfigDigest } from "../../scripts/pool-fleet/runtime-slot-manifest.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";
import {
  primaryRetirementProvider,
  startupAbortProvider,
} from "./runtime-slots/provider-retirement.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";

/** The provider lists the runtime's one instance in `state`, as production lists a stopped one. */
async function listed(state: string) {
  const f = await runtimeProofFixture();
  const reader = new RuntimeProviderReader(
    "synthetic-only-provider-token",
    async (input) =>
      Response.json({
        success: true,
        errors: [],
        result: new URL(input).pathname.endsWith("instances-v2")
          ? [
              {
                id: f.manifest.target.instanceId,
                image: f.raw.configuration.image,
                application_id: f.raw.id,
                status: { state },
              },
            ]
          : f.raw,
        result_info: { next_page_token: "" },
      }),
    () => f.now,
  );
  const provider = {
    ...f.manifest.provider,
    applicationId: f.raw.id,
    applicationVersion: "1",
    imageDigest: f.manifest.target.imageDigest,
    applicationConfigDigest: runtimeApplicationConfigDigest(decodeProviderApplication(f.raw)),
    observationDigest: "8".repeat(64),
    observedAt: f.now,
  };
  const identity = { ...f.manifest.target, bootId: "22222222-2222-2222-2222-222222222222" };
  const stop = (status: "pending" | "aborted") => ({
    intent: {
      operationId: "provider-abort",
      target: f.manifest.target,
      startupOperationId: "provider-start",
      witness: null,
    },
    provider,
    status,
    destroySent: true,
  });
  return { reader, provider, identity, stop };
}

const refused = (error: unknown) => error instanceof SlotRefused && error.reason === "uncertain";

test("a retired primary its driver reports stopped is absent while the provider lists it inactive", async () => {
  const f = await listed("inactive");
  await primaryRetirementProvider(f.reader)("absent", {
    identity: f.identity,
    retired: true,
    running: false,
    provider: f.provider,
  });
});

test("an aborted start its driver reports stopped is absent while the provider lists it inactive", async () => {
  const f = await listed("inactive");
  await startupAbortProvider(f.reader)(f.stop("aborted"));
});

test("without the driver's stopped report an inactive listing proves no absence on either path", async () => {
  const f = await listed("inactive");
  const absent = primaryRetirementProvider(f.reader);
  for (const report of [
    { retired: false, running: false },
    { retired: true, running: true },
  ])
    await assert.rejects(
      absent("absent", { identity: f.identity, ...report, provider: f.provider }),
      refused,
    );
  await assert.rejects(startupAbortProvider(f.reader)(f.stop("pending")), refused);
});

test("with the driver's stopped report a stopped or running listing is still present on both paths", async () => {
  for (const state of ["stopped", "running"]) {
    const f = await listed(state);
    await assert.rejects(
      primaryRetirementProvider(f.reader)("absent", {
        identity: f.identity,
        retired: true,
        running: false,
        provider: f.provider,
      }),
      refused,
    );
    await assert.rejects(startupAbortProvider(f.reader)(f.stop("aborted")), refused);
  }
});
