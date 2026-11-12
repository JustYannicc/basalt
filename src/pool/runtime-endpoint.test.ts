import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { Schema } from "effect";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import {
  joinedRuntimeProof,
  runtimeGrant,
  runtimeFixtureCode,
} from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { RuntimeEndpoint } from "./runtime-slots/endpoint.ts";
import {
  StartAuthorization,
  InitialStartAuthorization,
  launchWitnessKey,
  runtimeAttestationFormat,
} from "./runtime-slots/admission-proof.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";
import { configurationDigest, runtimeConfiguration } from "./runtime-slots/configuration.ts";
import { signEnvelope } from "./token.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";

async function fixture(initial = false) {
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "candidate",
    applicationId: "candidate-app",
    applicationVersion: "3",
    instanceId: "b".repeat(64),
    imageDigest: `sha256:${"d".repeat(64)}`,
    imageInput: "2".repeat(16),
    ...(initial ? { homePeerOrdinal: 1 } : {}),
  };
  const f = await handoffRuntime(target, {
    POOL_RUNTIME_APPLICATION_ID: target.applicationId,
    POOL_CONTAINER_APPLICATION_ID: "old-app",
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-runtime-key",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: target.imageInput,
    POOL_DEPLOYMENT_KEY: "e".repeat(64),
  });
  const controller = new RuntimeSqlite();
  const old = {
    ...target,
    slotId: "old",
    applicationId: "old-app",
    instanceId: target.controllerId,
    bootId: "old-boot",
  };
  if (!initial)
    await controller.put(slotSelectionKey, {
      epoch: 1,
      active: { target: old, identity: old, fenced: false },
    });
  const grant = await runtimeGrant(f, controller, initial ? "initial-start" : "start");
  await f.endpoint.admit(grant.envelope);
  return {
    ...f,
    controller,
    grant,
    cleanup: async () => {
      await f.cleanup();
      await controller.close();
    },
  };
}

test("an independent runtime starts from explicit first-start authority and attests its actual ordinal and boot", async (context) => {
  const f = await fixture(true);
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  assert.equal(identity.homePeerOrdinal, 1);
  assert.equal(f.calls.start, 1);
  const joined = await joinedRuntimeProof(
    f,
    f.controller,
    Schema.decodeUnknownSync(InitialStartAuthorization)(f.grant.proof),
  );
  const wrongKind = await signEnvelope(f.env.POOL_DEPLOYMENT_KEY!, runtimeAttestationFormat, {
    ...joined.proof,
    kind: "attested",
  });
  await assert.rejects(f.endpoint.attest(wrongKind));
  await f.endpoint.attest(joined.envelope);
  const ready = await f.endpoint.ready(identity, await f.digest(), f.target.imageInput);
  assert.equal(ready.identity.bootId, identity.bootId);
  const reconstructed = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
  assert.equal(
    (await reconstructed.start(f.target, AbortSignal.timeout(2_000))).identity.bootId,
    identity.bootId,
  );
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.destroy, 0);
});

test("a reconstructed endpoint waits for the actual response body before destroying its runtime", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  let terminal!: () => void;
  f.hooks.model = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: started\n\n"));
          terminal = () => controller.close();
        },
      }),
    );
  const response = await f.endpoint.fetch(identity, new Request("http://pool/v1/responses"), 8317);
  const reconstructed = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
  assert.deepEqual(await reconstructed.drain(identity, AbortSignal.timeout(2_000)), {
    active: 1,
    known: true,
  });
  await assert.rejects(
    reconstructed.retire(f.target, identity, AbortSignal.timeout(2_000)),
    SlotRefused,
  );
  await assert.rejects(
    f.endpoint.fetch(identity, new Request("http://pool/v1/responses"), 8317),
    SlotRefused,
  );
  assert.equal(f.calls.model, 1);
  assert.equal(f.calls.destroy, 0);
  terminal();
  assert.match(await response.text(), /started/);
  assert.deepEqual(await reconstructed.drain(identity, AbortSignal.timeout(2_000)), {
    active: 0,
    known: true,
  });
  await reconstructed.retire(f.target, identity, AbortSignal.timeout(2_000));
  assert.equal(f.calls.destroy, 1);
  await assert.rejects(f.endpoint.retire(f.target, identity, AbortSignal.timeout(2_000)));
  assert.equal(f.calls.destroy, 1);
});

test("a lost destroy reply is inspect-only after endpoint reconstruction", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await f.endpoint.drain(identity, AbortSignal.timeout(2_000));
  f.ctx.container.destroy = async () => {
    f.calls.destroy++;
    throw new Error("lost destroy response");
  };
  await assert.rejects(
    f.endpoint.retire(f.target, identity, AbortSignal.timeout(2_000)),
    /lost destroy/,
  );
  const reconstructed = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
  await assert.rejects(
    reconstructed.retire(f.target, identity, AbortSignal.timeout(2_000)),
    /uncertain/,
  );
  assert.equal(f.calls.destroy, 1);
});

test("actual runtime start retains its measured launch witness and settings through reconstruction", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const first = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const observed = await f.endpoint.witness(f.target);
  assert.equal(observed.kind, "witness");
  assert.ok("witness" in observed && observed.witness?.bootId);
  assert.equal(observed.witness.bootId, first.identity.bootId);
  assert.equal(observed.witness.configurationFingerprint, await f.digest());
  assert.ok(!JSON.stringify(observed).includes(f.env.POOL_MANAGEMENT_KEY));
  const reconstructed = new RuntimeEndpoint(
    f.ctx,
    { ...f.env, POOL_MANAGEMENT_KEY: "fixture-new-key", POOL_IMAGE_HASH: "3".repeat(16) },
    "runtime",
    runtimeFixtureCode,
    f.wrap,
  );
  assert.equal(
    (await reconstructed.health(first.identity, AbortSignal.timeout(2_000))).identity.bootId,
    first.identity.bootId,
  );
  assert.equal(
    (await reconstructed.start(f.target, AbortSignal.timeout(2_000))).identity.bootId,
    first.identity.bootId,
  );
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.destroy, 0);
});

test("candidate readiness needs a release join matching the actual launch witness", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const health = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const fingerprint = await configurationDigest(runtimeConfiguration(f.env));
  await assert.rejects(f.endpoint.ready(health.identity, fingerprint, f.target.imageInput));
  const authorization = Schema.decodeUnknownSync(StartAuthorization)(f.grant.proof);
  const joined = await joinedRuntimeProof(f, f.controller, authorization);
  for (const delta of [
    { bootId: "wrong-boot" },
    { configurationFingerprint: "9".repeat(64) },
    { launch: { ...joined.proof.launch, generation: joined.proof.launch.generation + 1 } },
    { launch: { ...joined.proof.launch, tokenHash: "8".repeat(64) } },
  ]) {
    const envelope = await signEnvelope(f.env.POOL_DEPLOYMENT_KEY!, runtimeAttestationFormat, {
      ...joined.proof,
      ...delta,
    });
    await assert.rejects(f.endpoint.attest(envelope));
  }
  await f.endpoint.attest(joined.envelope);
  assert.equal(
    (await f.endpoint.ready(health.identity, fingerprint, f.target.imageInput)).identity.bootId,
    health.identity.bootId,
  );
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.destroy, 0);
});

test("a lost durable witness acknowledgement cannot dispatch compute on retry", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  let lost = false;
  f.storage.afterCommit = (keys) => {
    if (!lost && keys.includes(launchWitnessKey(f.target.slotId))) {
      lost = true;
      throw new Error("lost durable witness reply");
    }
  };
  await assert.rejects(
    f.endpoint.start(f.target, AbortSignal.timeout(5_000)),
    /lost durable witness reply/u,
  );
  f.storage.afterCommit = () => {};
  await assert.rejects(
    f.endpoint.start(f.target, AbortSignal.timeout(5_000)),
    /launch-result-uncertain/u,
  );
  assert.equal(f.calls.start, 0);
  const observation = await f.endpoint.witness(f.target);
  assert.ok(
    "witness" in observation && observation.witness && observation.witness.bootId === undefined,
  );
});

test("reconstruction observes a committed start and refuses a changed boot without restarting", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const reconstructed = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
  const observed = await reconstructed.observe(f.target, AbortSignal.timeout(2_000));
  assert.equal(observed.identity.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
  f.replaceBoot();
  await assert.rejects(reconstructed.health(observed.identity, AbortSignal.timeout(2_000)));
  await assert.rejects(reconstructed.start(f.target, AbortSignal.timeout(2_000)));
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.destroy, 0);
});

test("runtime observations never renew the idle timer, while explicit warming keeps the same boot alive", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const started = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const before = f.calls.keepAlive;
  let writes = 0;
  f.storage.afterCommit = (keys) => {
    writes += keys.length;
  };
  await f.endpoint.witness(f.target);
  await f.endpoint.health(started.identity, AbortSignal.timeout(2_000));
  assert.equal(f.calls.keepAlive, before);
  assert.equal(writes, 0);
  const warm = await f.endpoint.warm(started.identity, AbortSignal.timeout(2_000));
  assert.equal(warm.identity.bootId, started.identity.bootId);
  assert.equal(f.calls.keepAlive, before + 1);
  assert.equal(writes, 0);
  f.crash();
  await assert.rejects(f.endpoint.warm(started.identity, AbortSignal.timeout(2_000)));
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.destroy, 0);
});

test("the production runtime DO serves a health read after reconstruction without persistent writes or idle renewal", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const health = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const hooks = registerHooks({
    resolve(specifier, moduleContext, next) {
      if (specifier === "cloudflare:workers")
        return {
          url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
          shortCircuit: true,
        };
      return next(specifier, moduleContext);
    },
  });
  const runtimePath = "./runtime-do.worker.ts";
  const {
    PoolRuntime,
  }: {
    PoolRuntime: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response> };
  } = await import(runtimePath);
  hooks.deregister();
  const before = f.calls.keepAlive;
  let writes = 0;
  f.storage.afterCommit = (keys) => {
    writes += keys.length;
  };
  const runtime = new PoolRuntime(f.ctx, f.env);
  const response = await runtime.fetch(
    new Request("http://runtime/health", {
      method: "POST",
      body: JSON.stringify({ target: health.identity }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(f.calls.keepAlive, before);
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.destroy, 0);
  assert.equal(writes, 0);
});
