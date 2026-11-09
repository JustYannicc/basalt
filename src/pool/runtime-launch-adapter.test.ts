import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchLedger, launchTokenHash } from "./launch-ledger.ts";
import type { LaunchTarget } from "./launch-contract.ts";
import {
  launchGenerationHeader,
  launchTokenHashHeader,
  policyHealthHeader,
} from "./runtime-health.ts";

const runtimeModule = "./runtime.worker.ts";
const {
  createPoolLifecycle,
}: {
  createPoolLifecycle(
    ctx: object,
    env: object,
    launch?: { ledger: LaunchLedger; binding: Omit<LaunchTarget, "releaseEpoch"> },
  ): Promise<{ warm(): Promise<unknown> }>;
} = await import(runtimeModule);

test("optional production adapter passes the durable identity to its bound container and proves it", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const target: LaunchTarget = {
    controllerId: "a".repeat(64),
    instanceId: "b".repeat(64),
    applicationId: "application",
    versionId: "version",
    imageHash: "c".repeat(64),
    imageDigest: "sha256:" + "c".repeat(64),
    releaseEpoch: "d".repeat(64),
  };
  const ledger = new LaunchLedger(storage, async () => target);
  let running = false;
  let starts = 0;
  let launched: Record<string, string> = {};
  const ctx = {
    id: { toString: () => target.instanceId },
    storage,
    container: {
      get running() {
        return running;
      },
      start(options: { env: Record<string, string> }) {
        starts++;
        launched = options.env;
        running = true;
      },
      destroy: async () => {
        throw new Error("unexpected destruction");
      },
      setInactivityTimeout: async () => {},
      getTcpPort(port: number) {
        assert.equal(port, 8318);
        return {
          fetch: async () =>
            Response.json(
              {
                boot_id: "00000000-0000-4000-8000-000000000001",
                started_at: "2026-11-09T00:00:00Z",
              },
              {
                headers: {
                  [policyHealthHeader]: "1500",
                  [launchGenerationHeader]: launched.POOL_LAUNCH_GENERATION!,
                  [launchTokenHashHeader]: await launchTokenHash(launched.POOL_LAUNCH_TOKEN!),
                },
              },
            ),
        };
      },
    },
  };
  const env = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture",
    POOL_APP_SIGNING_KEY: "e".repeat(64),
    POOL_IMAGE_HASH: target.imageHash,
  };
  const { releaseEpoch: _epoch, ...binding } = target;
  await (await createPoolLifecycle(ctx, env, { ledger, binding })).warm();
  assert.equal(launched.POOL_LAUNCH_GENERATION, "1");
  const record = await ledger.current();
  assert.equal(record?.token, launched.POOL_LAUNCH_TOKEN);
  assert.ok(record?.bootId);
  assert.equal(JSON.stringify(await ledger.inspect()).includes(launched.POOL_LAUNCH_TOKEN!), false);
  running = false;
  await assert.rejects(
    (
      await createPoolLifecycle(
        ctx,
        { ...env, POOL_IMAGE_HASH: "f".repeat(64) },
        { ledger, binding },
      )
    ).warm(),
    /bound-runtime-drift/,
  );
  assert.equal(starts, 1);
});
