import assert from "node:assert/strict";
import { readEnd } from "./runtime-slots/container-end.ts";
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
import { BoundSlotDriver, runtimeRequest } from "./runtime-slots/transport.ts";
import {
  StartAuthorization,
  InitialStartAuthorization,
  launchWitnessKey,
  runtimeAttestationFormat,
} from "./runtime-slots/admission-proof.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";
import { configurationDigest, runtimeConfiguration } from "./runtime-slots/configuration.ts";
import { signEnvelope } from "./token.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";

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
  const { end, ...retired } = await reconstructed.retirement(identity);
  assert.deepEqual(retired, {
    identity,
    retired: true,
    running: false,
    provider: f.grant.proof.provider,
  });
  assert.equal(readEnd(end)?.stopSent, true, "a stop we sent read as a crash");
  await assert.rejects(f.endpoint.retire(f.target, identity, AbortSignal.timeout(2_000)));
  assert.equal(f.calls.destroy, 1);
});

test("a lost destroy reply is inspect-only after endpoint reconstruction", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await f.endpoint.drain(identity, AbortSignal.timeout(2_000));
  // Home is still draining when the grace ends, and the destroy that follows loses its reply.
  f.ctx.container.signal = (signal: number) => {
    f.calls.signals.push(signal);
  };
  f.ctx.container.destroy = async () => {
    f.calls.destroy++;
    throw new Error("lost destroy response");
  };
  await assert.rejects(
    f.endpoint.retire(f.target, identity, AbortSignal.timeout(2_000)),
    /lost destroy/,
  );
  assert.deepEqual(f.calls.signals, [15]);
  const reconstructed = new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
  await assert.rejects(
    reconstructed.retire(f.target, identity, AbortSignal.timeout(2_000)),
    /uncertain/,
  );
  assert.equal(f.calls.destroy, 1);
  assert.deepEqual(await reconstructed.retirement(identity), {
    identity,
    retired: false,
    running: true,
    stopping: true,
    provider: f.grant.proof.provider,
  });
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

for (const matchingApplication of [true, false])
  test(`candidate startup settings bind only to their exact application (matching=${matchingApplication})`, async (context) => {
    const f = await fixture();
    context.after(f.cleanup);
    await f.storage.delete(launchWitnessKey(f.target.slotId));
    const desired = runtimeConfiguration(f.env);
    const endpoint = new RuntimeEndpoint(
      f.ctx,
      {
        ...f.env,
        POOL_MANAGEMENT_KEY: "preserved-legacy-key",
        POOL_CANDIDATE_APPLICATION_ID: matchingApplication
          ? f.target.applicationId
          : "another-application",
        POOL_CANDIDATE_RUNTIME_CONFIGURATION: JSON.stringify(desired),
      },
      "runtime",
      runtimeFixtureCode,
      f.wrap,
    );
    if (!matchingApplication) {
      await assert.rejects(endpoint.admit(f.grant.envelope), /identity/);
      assert.equal(f.calls.start, 0);
      return;
    }
    await endpoint.admit(f.grant.envelope);
    const started = await endpoint.start(f.target, AbortSignal.timeout(5_000));
    const witness = await endpoint.witness(f.target);
    assert.ok(witness.kind === "witness");
    assert.ok(witness.witness);
    assert.equal(witness.witness.configurationFingerprint, await configurationDigest(desired));
    assert.equal(f.calls.start, 1);
    assert.equal(JSON.stringify(witness).includes(desired.managementKey), false);
    const restored = new RuntimeEndpoint(
      f.ctx,
      { ...f.env, POOL_MANAGEMENT_KEY: "preserved-legacy-key" },
      "runtime",
      runtimeFixtureCode,
      f.wrap,
    );
    assert.equal(
      (await restored.health(started.identity, AbortSignal.timeout(2_000))).identity.bootId,
      started.identity.bootId,
    );
    assert.equal(f.calls.start, 1);
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
          url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
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

test("every model send reads readiness again, so a readiness refusal right after admission is never sent", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  // The controller's admission read grants a fresh lease.
  await f.endpoint.health(identity, AbortSignal.timeout(2_000));
  const reads = f.calls.health;
  // Readiness then refuses, as it does when the policy plugin fuses. The endpoint can't tell a fuse
  // from a flip, so the lease it just granted must not carry the request past that refusal.
  f.hooks.health = async () => new Response("policy unavailable", { status: 503 });
  await assert.rejects(
    f.endpoint.fetch(identity, new Request("http://pool/v1/responses"), 8317),
    PoolRuntimeUnhealthy,
  );
  assert.equal(f.calls.health, reads + 1, "the send read readiness again");
  assert.equal(f.calls.model, 0, "nothing reached the model port");

  // A readiness read that fails in transport is degraded readiness the caller can wait on, not a
  // defect, and it is never sent either.
  f.hooks.health = async () => {
    throw new TypeError("readiness transport failed");
  };
  await assert.rejects(
    f.endpoint.fetch(identity, new Request("http://pool/v1/responses"), 8317),
    PoolRuntimeUnhealthy,
  );
  assert.equal(f.calls.health, reads + 2, "the send read readiness again");
  assert.equal(f.calls.model, 0);
});

test("a warm writes one endpoint line timing its identity read, its readiness read's steps and its keep-alive", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const info = context.mock.method(console, "info", () => {});
  f.hooks.health = () => new Promise<void>((done) => setTimeout(done, 40));
  f.hooks.keepAlive = () => new Promise<void>((done) => setTimeout(done, 30));
  await f.endpoint.warm(identity, AbortSignal.timeout(2_000));
  const lines = info.mock.calls
    .filter(({ arguments: [name] }) => name === "POOL_RUNTIME_UPKEEP")
    .map(({ arguments: [, fields] }) => fields as Record<string, unknown>);
  assert.equal(lines.length, 1, "one line for the warm, none per step");
  const [line] = lines as [
    { side: string; phase: string; outcome: string; elapsedMs: number; phases: object },
  ];
  assert.deepEqual([line.side, line.phase, line.outcome], ["endpoint", "warm", "ended"]);
  const phases = line.phases as Record<string, number>;
  assert.deepEqual(Object.keys(phases).sort(), [
    "health_body",
    "health_headers",
    "health_identity",
    "identity",
    "keep_alive",
  ]);
  assert.ok(Object.values(phases).every((ms) => Number.isInteger(ms) && ms >= 0));
  assert.ok(phases.health_headers! >= 35, `the readiness read's wait: ${phases.health_headers}`);
  assert.ok(phases.keep_alive! >= 25, `the keep-alive: ${phases.keep_alive}`);
  assert.ok(line.elapsedMs >= phases.health_headers! + phases.keep_alive!);
  assert.equal(
    info.mock.calls.some(({ arguments: [name] }) => name === "POOL_RUNTIME_READ"),
    false,
    "the readiness read's steps join the warm's line, not lines of their own",
  );
});

test("readiness is read after the keep-alive, so a lease spent during it never admits the send", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await f.endpoint.health(identity, AbortSignal.timeout(2_000));
  // Readiness turns to 503 while the keep-alive call is in progress, as when the plugin fuses then.
  f.hooks.keepAlive = async () => {
    f.hooks.health = async () => new Response("policy unavailable", { status: 503 });
  };
  await assert.rejects(
    f.endpoint.fetch(identity, new Request("http://pool/v1/responses"), 8317),
    PoolRuntimeUnhealthy,
  );
  assert.equal(f.calls.model, 0, "nothing reached the model port");
});

test("a retired record is never admitted again, so its slot can't start a second container", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await f.endpoint.drain(identity, AbortSignal.timeout(2_000));
  await f.endpoint.retire(f.target, identity, AbortSignal.timeout(2_000));
  await assert.rejects(f.endpoint.admit(f.grant.envelope), /identity/);
  await assert.rejects(f.endpoint.start(f.target, AbortSignal.timeout(5_000)));
  assert.equal(f.calls.start, 1);
});

test("a fenced fleet start is never admitted or started again", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.endpoint.abandonStart(f.target);
  await assert.rejects(f.endpoint.admit(f.grant.envelope), /identity/);
  await assert.rejects(f.endpoint.start(f.target, AbortSignal.timeout(5_000)), /selection/);
  assert.equal(f.calls.start, 0);
});

test("a model call whose caller leaves before the container answers stops counting at once", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  let answer!: (response: Response) => void;
  let sent!: () => void;
  const reached = new Promise<void>((resolve) => (sent = resolve));
  f.hooks.model = () => {
    sent();
    return new Promise<Response>((resolve) => (answer = resolve));
  };
  const caller = new AbortController();
  const call = f.endpoint
    .fetch(identity, new Request("http://pool/v1/messages", { signal: caller.signal }), 8317)
    .catch(() => undefined);
  await reached;
  assert.equal((await f.endpoint.streamCount(identity)).active, 1);
  caller.abort();
  // The release is the object's own background write; it lands before the container answers.
  await f.settle();
  assert.equal((await f.endpoint.streamCount(identity)).active, 0);
  // The late answer goes nowhere and releases nothing twice.
  answer(new Response("{}"));
  await call;
  assert.equal((await f.endpoint.streamCount(identity)).active, 0);
});

const unstampedLease = async (f: Awaited<ReturnType<typeof fixture>>, identity: SlotIdentity) => {
  const key = `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`;
  const row = (await f.ctx.storage.get(key)) as { active: number; leases?: object };
  // As code before the stamps left it, and as the stuck cell of 24 Nov holds six.
  await f.ctx.storage.put(key, {
    ...row,
    active: row.active + 1,
    leases: { ...row.leases, old: "active" },
  });
};
const fresh = (f: Awaited<ReturnType<typeof fixture>>) =>
  new RuntimeEndpoint(f.ctx, f.env, "runtime", runtimeFixtureCode, f.wrap);
/** A count read starts the proof in the background; the next read sees what it ended. */
const proven = async (
  f: Awaited<ReturnType<typeof fixture>>,
  endpoint: RuntimeEndpoint,
  identity: SlotIdentity,
) => {
  await endpoint.streamCount(identity);
  await f.settle();
  return (await endpoint.streamCount(identity)).active;
};

test("an unstamped lease ends only when the container reads no model connection", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const warned = context.mock.method(console, "warn", () => {});
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await unstampedLease(f, identity);
  f.hooks.connections = async () => 1;
  assert.equal(await proven(f, fresh(f), identity), 1, "a live connection keeps it");
  f.hooks.connections = async () => {
    throw new Error("probe failed");
  };
  assert.equal(await proven(f, fresh(f), identity), 1, "a failed read keeps it");
  // The read runs once per 30 s per boot: the same endpoint does not read again at once.
  const reader = fresh(f);
  f.hooks.connections = async () => 1;
  await proven(f, reader, identity);
  f.hooks.connections = async () => 0;
  assert.equal(await proven(f, reader, identity), 1, "no second read inside 30 s");
  assert.equal(await proven(f, fresh(f), identity), 0, "a read of 0 ends it");
  const lines = warned.mock.calls.map((call) => call.arguments);
  assert.ok(
    lines.some(
      ([line, fields]) =>
        line === "POOL_RUNTIME_LEASES_KEPT" &&
        (fields as { connections: unknown }).connections === "unknown",
    ),
  );
  const released = lines.find(([line]) => line === "POOL_RUNTIME_LEASES_RELEASED");
  assert.ok(released);
  const { key, ...line } = released[1] as { key: string };
  assert.deepEqual(line, { ordinal: null, kind: "unstamped", released: 1, connections: 0 });
  assert.match(key, /^[0-9a-f]{24}$/);
});

test("the proof never ends a call this instance holds, nor one it takes during the read", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  context.mock.method(console, "warn", () => {});
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  const answers: ((response: Response) => void)[] = [];
  let arrived = () => {};
  const arrival = () => new Promise<void>((resolve) => (arrived = resolve));
  f.hooks.model = () =>
    new Promise<Response>((resolve) => {
      answers.push(resolve);
      arrived();
    });
  const call = () =>
    f.endpoint.fetch(identity, new Request("http://pool/v1/messages", { method: "POST" }), 8317);
  const first = arrival();
  const held = call();
  await first;
  await unstampedLease(f, identity);
  let late: Promise<Response> | undefined;
  f.hooks.connections = async () => {
    const second = arrival();
    late = call();
    await second;
    return 0;
  };
  assert.equal(await proven(f, fresh(f), identity), 2);
  for (const answer of answers) answer(new Response("{}"));
  await (await held).text();
  await (await late!).text();
  await f.settle();
  assert.equal(await proven(f, fresh(f), identity), 0);
});

test("a drain whose health read fails still ends a lease the container shows is over", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const warned = context.mock.method(console, "warn", () => {});
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await unstampedLease(f, identity);
  let reads = 0;
  f.hooks.connections = async () => {
    reads++;
    return 0;
  };
  f.hooks.health = async () => new Response("policy unavailable", { status: 503 });
  const endpoint = fresh(f);
  await assert.rejects(endpoint.drain(identity, AbortSignal.timeout(2_000)));
  await f.settle();
  assert.equal(reads, 1, "the container's connections were read");
  assert.ok(warned.mock.calls.some((call) => call.arguments[0] === "POOL_RUNTIME_LEASES_RELEASED"));
});

test("a settle whose release fails writes one closed line and keeps the lease", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const warned = context.mock.method(console, "warn", () => {});
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await unstampedLease(f, identity);
  // The read proves the lease over, then the write that ends it fails.
  const original = f.ctx.storage.transaction.bind(f.ctx.storage);
  let broken = false;
  context.mock.method(f.ctx.storage, "transaction", (...input: Parameters<typeof original>) =>
    broken ? Promise.reject(new Error("storage said something private")) : original(...input),
  );
  f.hooks.connections = async () => {
    broken = true;
    return 0;
  };
  await fresh(f).streamCount(identity);
  await f.settle();
  broken = false;
  const failed = warned.mock.calls
    .map((call) => call.arguments)
    .filter(([line]) => line === "POOL_RUNTIME_LEASES_SETTLE_FAILED");
  assert.equal(failed.length, 1);
  const { key, ...fields } = failed[0]![1] as { key: string };
  assert.match(key, /^[0-9a-f]{24}$/);
  assert.deepEqual(
    { ordinal: null, reason: null, name: "Error", messageClass: "other", isError: true },
    Object.fromEntries(
      Object.entries(fields).filter(([name]) =>
        ["ordinal", "reason", "name", "messageClass", "isError"].includes(name),
      ),
    ),
  );
  assert.ok(!JSON.stringify(failed).includes("private"), "never the exception text");
  f.hooks.connections = async () => 1;
  assert.equal(await proven(f, fresh(f), identity), 1, "the lease is still counted");
});

test("storage that keeps failing is reported once per proof interval, not on every read", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const warned = context.mock.method(console, "warn", () => {});
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await unstampedLease(f, identity);
  context.mock.method(f.ctx.storage, "get", () => Promise.reject(new Error("broken")));
  const endpoint = fresh(f);
  for (let read = 0; read < 3; read++) {
    // The count read fails too; only its background settle's line is under test.
    await endpoint.streamCount(identity).catch(() => undefined);
    await f.settle();
  }
  const failed = warned.mock.calls.filter(
    (call) => call.arguments[0] === "POOL_RUNTIME_LEASES_SETTLE_FAILED",
  );
  assert.equal(failed.length, 1);
});

test("the proof read waits up to its 5 s, and the operator's read gives up at 1.5 s, on one read", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  context.mock.method(console, "warn", () => {});
  const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
  await unstampedLease(f, identity);
  // A container read slower than the operator's 1.5 s and inside the proof's 5 s.
  f.hooks.connections = () => new Promise<number>((resolve) => setTimeout(() => resolve(0), 2_000));
  const checked = await fresh(f).checkStill(identity);
  assert.equal(checked.connections, null, "the operator's read stops at 1.5 s");
  assert.equal(await proven(f, fresh(f), identity), 0, "the proof's read still ends the lease");
});

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
/** The controller's view of this endpoint: in its own isolate (the root), or across a hop (a cell). */
const controllerDriver = (endpoint: RuntimeEndpoint, hopMs = 0) =>
  new BoundSlotDriver(() => ({
    fetch: async (request: Request) => {
      const answer = await runtimeRequest(request, endpoint);
      if (hopMs) await pause(hopMs);
      return answer;
    },
  }));
/** The fixture's readiness answer (a 1500 ms grant), taking `readMs` to come. */
const slowReadiness = (readMs: number) => async () => {
  await pause(readMs);
};

for (const [where, hopMs] of [
  ["root", 0],
  ["cell", 100],
] as const)
  test(`the ${where}'s readiness read that takes 60 % of its lease is admitted: the read counts once`, async (context) => {
    const f = await fixture();
    context.after(f.cleanup);
    const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
    f.hooks.health = slowReadiness(900);
    const health = await controllerDriver(f.endpoint, hopMs).health(
      identity,
      AbortSignal.timeout(5_000),
    );
    // Counted from the controller's own send, so never longer than the container granted.
    assert.ok(health.policyLeaseUntil > performance.now());
    assert.ok(health.policyLeaseUntil - performance.now() < 1_500 - 900);
  });

// The root's read runs into the endpoint's 1500 ms deadline; the cell's read and hop together
// outlast the grant though the endpoint still saw it live.
for (const [where, readMs, hopMs] of [
  ["root", 1_700, 0],
  ["cell", 700, 900],
] as const)
  test(`the ${where}'s health that outlasts its lease is refused`, async (context) => {
    const f = await fixture();
    context.after(f.cleanup);
    context.mock.method(console, "warn", () => {});
    context.mock.method(console, "error", () => {});
    const { identity } = await f.endpoint.start(f.target, AbortSignal.timeout(5_000));
    f.hooks.health = slowReadiness(readMs);
    await assert.rejects(
      controllerDriver(f.endpoint, hopMs).health(identity, AbortSignal.timeout(5_000)),
      SlotRefused,
    );
  });
