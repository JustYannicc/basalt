import assert from "node:assert/strict";
import { test } from "node:test";
import { createPoolLifecycle } from "./runtime.worker.ts";
import { LaunchLedger, launchTokenHash } from "./launch-ledger.ts";
import {
  launchGenerationHeader,
  launchTokenHashHeader,
  policyHealthHeader,
} from "./runtime-health.ts";
import {
  configurationDigest,
  runtimeConfiguration,
  startupOptionsFingerprint,
  type StartupOptions,
} from "./runtime-slots/configuration.ts";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const env = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-management",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: "1".repeat(16),
  };
  const binding = {
    controllerId: "c".repeat(64),
    instanceId: "d".repeat(64),
    applicationId: "fixture-app",
    versionId: "1",
    imageHash: env.POOL_IMAGE_HASH,
    imageDigest: `sha256:${"b".repeat(64)}`,
  };
  let starts = 0,
    running = false,
    committed = false;
  let actual: StartupOptions | undefined;
  const ctx = {
    id: { toString: () => binding.instanceId },
    storage,
    waitUntil: () => {},
    container: {
      get running() {
        return running;
      },
      start(options: StartupOptions) {
        assert.ok(committed, "actual start must follow a durable trusted-options witness");
        starts++;
        actual = options;
        running = true;
      },
      destroy: async () => {
        running = false;
      },
      monitor: async () => {
        throw new Error("This scenario must not observe retirement");
      },
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({
        fetch: async () =>
          Response.json(
            {
              boot_id: "12345678-1234-1234-1234-123456789abc",
              started_at: "fixture",
            },
            {
              headers: {
                [policyHealthHeader]: "1500",
                [launchGenerationHeader]: actual!.env.POOL_LAUNCH_GENERATION!,
                [launchTokenHashHeader]: await launchTokenHash(actual!.env.POOL_LAUNCH_TOKEN!),
              },
            },
          ),
      }),
    },
  };
  const ledger = new LaunchLedger(storage, async () => ({
    ...binding,
    releaseEpoch: "e".repeat(64),
  }));
  return {
    ctx,
    env,
    binding,
    ledger,
    storage,
    values,
    get starts() {
      return starts;
    },
    get actual() {
      return actual;
    },
    commit: () => {
      committed = true;
    },
  };
}

test("the actual launch waits for durable options evidence and binds its exact launch challenge", async () => {
  const f = fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  const lifecycle = await createPoolLifecycle(f.ctx, f.env, {
    ledger: f.ledger,
    binding: f.binding,
    beforeStart: async (record, options) => {
      await f.storage.put("fixture-startup-witness", {
        generation: record.generation,
        tokenHash: await launchTokenHash(record.token),
        fingerprint: await startupOptionsFingerprint(options),
      });
      entered.resolve();
      await release.promise;
      f.commit();
    },
  });
  const warming = lifecycle.warm();
  await Promise.race([
    entered.promise,
    warming.then(() => {
      throw new Error("start bypassed witness callback");
    }),
  ]);
  assert.equal(f.starts, 0);
  release.resolve();
  const status = await warming;
  const witness = await f.storage.get<{
    generation: number;
    tokenHash: string;
    fingerprint: string;
  }>("fixture-startup-witness");
  assert.ok(witness && f.actual);
  assert.equal(f.starts, 1);
  assert.equal(witness.fingerprint, await startupOptionsFingerprint(f.actual));
  assert.equal(witness.fingerprint, await configurationDigest(runtimeConfiguration(f.env)));
  assert.equal(witness.generation, status.launch?.generation);
  assert.equal(witness.tokenHash, status.launch?.tokenHash);
});

test("failed durable witness leaves a pending launch and cannot trigger a retry start", async () => {
  const f = fixture();
  const lifecycle = await createPoolLifecycle(f.ctx, f.env, {
    ledger: f.ledger,
    binding: f.binding,
    beforeStart: async () => {
      throw new Error("fixture durable write rejected");
    },
  });
  await assert.rejects(lifecycle.warm(), /durable write rejected/u);
  const pending = await f.ledger.current();
  assert.ok(pending && !pending.bootId);
  await assert.rejects(lifecycle.warm(), /launch-result-uncertain/u);
  assert.equal(f.starts, 0);
  assert.equal((await f.ledger.current())?.generation, pending.generation);
});
