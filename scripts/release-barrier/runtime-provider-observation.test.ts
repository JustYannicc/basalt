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
import { signPoolToken } from "../../src/pool/token.ts";
import { BarrierRefusal } from "./refusal.ts";

const encryptionKey = "a".repeat(64);
const Receipt = Schema.Struct({
  status: Schema.Literals(["observed", "refused"]),
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
    const writes: string[] = [];
    const previousCommit = f.old.storage.afterCommit;
    f.old.storage.afterCommit = (keys) => {
      previousCommit(keys);
      writes.push(...keys);
    };
    const calls = structuredClone(f.old.calls);
    const instances = f.instances.size;
    let reads = 0;
    const providerFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      reads++;
      assert.equal(init?.method, "GET");
      if (fault === "provider") return new Response(null, { status: 403 });
      if (fault === "transport") throw new Error("private-provider-marker");
      return providerFetch(input, init);
    };
    if (fault === "secret") f.secretAvailable(false);
    const root = f.state.applications.root;
    const state = {
      ...f.state,
      applications: {
        ...f.state.applications,
        root: {
          ...root,
          attributes: {
            ...root.attributes,
            version: root.attributes.version + (fault === "identity" ? 1 : 0),
          },
        },
      },
    };
    const input = { state, code: runtimeFixtureCode, client: f.client, directory, encryptionKey };
    if (fault === "none") {
      const observed = await verifyBoundProviderObservation(input);
      assert.equal(observed.proof.applicationId, state.applications.root.attributes.applicationId);
      assert.equal(observed.credentialBinding, "POOL_PROVIDER_OBSERVATION_TOKEN");
    } else {
      await assert.rejects(verifyBoundProviderObservation(input), (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.equal(
          error.reason,
          fault === "transport"
            ? "runtime-provider-observation-provider_fetch_failed"
            : "runtime-provider-observation-provider_observation_refused",
        );
        assert.equal(error.delta?.changed[0]?.path, "handoff.response.status");
        return true;
      });
    }
    const publicText = await readFile(join(directory, "provider-observation.json"), "utf8");
    const sealedText = await readFile(join(directory, "provider-observation.sealed.json"), "utf8");
    const summary = Schema.decodeUnknownSync(
      Schema.Struct({
        fingerprint: Schema.String,
        status: Schema.Literals(["observed", "refused"]),
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
    if (fault !== "none") {
      assert.match(
        publicText,
        /runtime-provider-observation-provider_(observation_refused|fetch_failed)/,
      );
      assert.match(publicText, /handoff.response.status/);
    }
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
    assert.deepEqual(writes, []);
    assert.deepEqual(f.old.calls, calls);
    assert.equal(f.instances.size, instances);
    assert.deepEqual(f.commands, ["provider-observe"]);
    assert.equal(reads, fault === "secret" ? 0 : 1);
  });

for (const fault of ["drift", "stale", "unexpected"] as const)
  test(`the provider gate retains safe ${fault} diagnostics without exception text`, async (context) => {
    const f = await runtimeReleaseClientFixture();
    const directory = await mkdtemp(join(tmpdir(), "pool-observation-diagnostic-"));
    context.after(async () => {
      await f.cleanup();
      await rm(directory, { recursive: true, force: true });
    });
    const client = {
      observeProvider: async (...args: Parameters<typeof f.client.observeProvider>) => {
        if (fault === "unexpected") throw new Error("arbitrary-private-observation-marker");
        const observation = await f.client.observeProvider(...args);
        return {
          ...observation,
          proof: {
            ...observation.proof,
            ...(fault === "drift"
              ? { applicationVersion: "different-version" }
              : { observedAt: Date.now() - 60_000 }),
          },
        };
      },
    };
    const reason =
      fault === "drift"
        ? "provisioning-input-drift"
        : fault === "stale"
          ? "runtime-provider-observation-stale"
          : "runtime-provider-observation-refused";
    await assert.rejects(
      verifyBoundProviderObservation({
        state: f.state,
        code: runtimeFixtureCode,
        client,
        directory,
        encryptionKey,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.equal(error.reason, reason);
        if (fault === "drift")
          assert.equal(error.delta?.changed[0]?.path, "runtime-provider-observation.target");
        return true;
      },
    );
    const publicText = await readFile(join(directory, "provider-observation.json"), "utf8");
    assert.ok(publicText.includes(reason));
    assert.equal(publicText.includes("arbitrary-private-observation-marker"), false);
    if (fault === "drift") assert.match(publicText, /runtime-provider-observation.target/);
  });

test("REHEARSAL-ONLY: a stage's plain observation secret reaches provider-observe through the controller and returns the proof", async (context) => {
  const f = await runtimeReleaseClientFixture(undefined, { plainObservationToken: true });
  const directory = await mkdtemp(join(tmpdir(), "pool-observation-plain-"));
  context.after(async () => {
    await f.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  await f.settle();
  const commands = f.commands.length;
  let reads = 0;
  const providerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    reads++;
    assert.equal(init?.method, "GET");
    return providerFetch(input, init);
  };
  context.after(() => {
    globalThis.fetch = providerFetch;
  });
  const observed = await verifyBoundProviderObservation({
    state: f.state,
    code: runtimeFixtureCode,
    client: f.client,
    directory,
    encryptionKey,
  });
  assert.equal(observed.credentialBinding, "POOL_PROVIDER_OBSERVATION_TOKEN");
  assert.equal(observed.proof.applicationId, f.state.applications.root.attributes.applicationId);
  assert.deepEqual(f.commands.slice(commands), ["provider-observe"]);
  assert.equal(reads, 1);
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

for (const fault of ["secret", "denied", "identity"] as const)
  test(`new Worker code keeps the unadopted old runtime serving after a ${fault} bound GET refusal`, async (context) => {
    const f = await runtimeReleaseClientFixture(undefined, { adopt: false });
    const directory = await mkdtemp(join(tmpdir(), "pool-observation-legacy-"));
    context.after(async () => {
      await f.cleanup();
      await rm(directory, { recursive: true, force: true });
    });
    await f.settle();
    // Persisted readiness from the pre-fleet legacy configuration, with no peer ordinal.
    const legacyRevision = "d176b4471f1eca617e2dbe3c48e4cc5488052d6675edd36dbc1475c097693209";
    await f.old.storage.put("revision", legacyRevision);
    await f.old.storage.put("ready-revision", legacyRevision);
    const identity = f.old.identity();
    const started = f.old.calls.start;
    const destroyed = f.old.calls.destroy;
    const root = f.state.applications.root;
    const state = {
      ...f.state,
      applications: {
        ...f.state.applications,
        root: {
          ...root,
          attributes: {
            ...root.attributes,
            version: root.attributes.version + (fault === "identity" ? 1 : 0),
          },
        },
      },
    };
    const providerFetch = globalThis.fetch;
    if (fault === "secret") f.secretAvailable(false);
    if (fault === "denied") globalThis.fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(
      verifyBoundProviderObservation({
        state,
        code: runtimeFixtureCode,
        client: f.client,
        directory,
        encryptionKey,
      }),
      /runtime-provider-observation-provider_observation_refused/,
    );
    globalThis.fetch = providerFetch;
    const token = await signPoolToken(f.old.env.POOL_APP_SIGNING_KEY!, f.claims);
    for (let request = 0; request < 3; request++) {
      const response = await f.publicModel(
        new Request("https://pool.invalid/v1/models", {
          headers: { authorization: `Bearer ${token}` },
        }),
        { pool: f.claims.pool, person: f.claims.owner },
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { data: [{ id: identity.bootId }] });
    }
    assert.deepEqual(f.old.identity(), identity);
    assert.equal(f.old.calls.start, started);
    assert.equal(f.old.calls.destroy, destroyed);
    assert.equal(f.old.calls.model, 3);
    assert.equal(f.instances.size, 0);
    assert.deepEqual(f.commands, ["provider-observe"]);
    assert.equal((await f.client.inspect()).selection, undefined);
  });
