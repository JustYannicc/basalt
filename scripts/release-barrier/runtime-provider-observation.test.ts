import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Schema } from "effect";
import { runtimeReleaseClientFixture } from "./test/runtime-release-client-fixture.ts";
import { runtimeFixtureCode } from "../pool-tests/runtime-handoff-proofs.ts";
import { verifyBoundProviderObservation } from "./runtime-provider-observation.ts";
import { openRecovery } from "./recovery-envelope.ts";
import {
  ProviderObservationTarget,
  observeBoundProvider,
} from "../../src/pool/runtime-provider/observation.ts";
import { runtimeApplicationPins } from "./runtime-release-state.ts";

const encryptionKey = "a".repeat(64);
const Receipt = Schema.Struct({
  status: Schema.Literal("observed", "refused"),
  credentialBinding: Schema.Literal("POOL_PROVIDER_OBSERVATION_TOKEN"),
  target: ProviderObservationTarget,
});

for (const fault of ["none", "secret", "provider", "identity", "transport"] as const)
  test(`the release retains a binding-backed provider observation with ${fault} failure and no runtime writes`, async (context) => {
    const f = await runtimeReleaseClientFixture();
    const directory = await mkdtemp(join(tmpdir(), "pool-observation-"));
    context.after(async () => {
      await f.cleanup();
      await rm(directory, { recursive: true, force: true });
    });
    await f.settle();
    const stored = structuredClone(f.old.storage.valuesMap);
    const calls = structuredClone(f.old.calls);
    const instances = f.instances.size;
    const reads = f.providerReads.length;
    if (fault === "secret") f.secretAvailable(false);
    if (fault === "provider") f.providerAvailable(false);
    if (fault === "transport")
      f.onProviderRead(async () => {
        throw new Error("private-provider-marker");
      });
    const state = structuredClone(f.state);
    if (fault === "identity") state.applications.root.attributes.version++;
    const input = { state, code: runtimeFixtureCode, client: f.client, directory, encryptionKey };
    if (fault === "none") {
      const observed = await verifyBoundProviderObservation(input);
      assert.equal(observed.proof.applicationId, state.applications.root.attributes.applicationId);
      assert.equal(observed.credentialBinding, "POOL_PROVIDER_OBSERVATION_TOKEN");
    } else {
      await assert.rejects(
        verifyBoundProviderObservation(input),
        /runtime-provider-observation-refused/,
      );
    }
    const publicText = await readFile(join(directory, "provider-observation.json"), "utf8");
    const sealedText = await readFile(join(directory, "provider-observation.sealed.json"), "utf8");
    const summary = Schema.decodeUnknownSync(
      Schema.Struct({
        fingerprint: Schema.String,
        status: Schema.Literal("observed", "refused"),
      }),
    )(JSON.parse(publicText));
    const receipt = Schema.decodeUnknownSync(Receipt)(
      openRecovery(
        JSON.parse(sealedText),
        encryptionKey,
        runtimeFixtureCode.candidate,
        summary.fingerprint,
      ),
    );
    assert.equal(summary.status, fault === "none" ? "observed" : "refused");
    assert.equal(receipt.status, summary.status);
    assert.equal(receipt.target.accountId, state.target.accountId);
    assert.equal(receipt.target.applicationId, state.applications.root.attributes.applicationId);
    for (const marker of [
      state.target.accountId,
      receipt.target.applicationId,
      "synthetic-provider-read",
      "private-provider-marker",
    ])
      assert.equal((publicText + sealedText).includes(marker), false);
    assert.deepEqual(f.old.storage.valuesMap, stored);
    assert.deepEqual(f.old.calls, calls);
    assert.equal(f.instances.size, instances);
    assert.deepEqual(f.commands, ["provider-observe"]);
    assert.equal(f.providerReads.length - reads, fault === "secret" ? 0 : 1);
  });

test("credential acceptance refuses a plaintext credential instead of bypassing the deployed binding", async (context) => {
  const f = await runtimeReleaseClientFixture();
  context.after(f.cleanup);
  const reads = f.providerReads.length;
  const application = f.state.applications.root;
  const target = Schema.decodeUnknownSync(ProviderObservationTarget)(
    runtimeApplicationPins(application.attributes, application.image.inputHash),
  );
  await assert.rejects(observeBoundProvider("synthetic-provider-read", target));
  assert.equal(f.providerReads.length, reads);
});
