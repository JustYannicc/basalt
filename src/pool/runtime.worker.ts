import {
  runtimeConfiguration,
  runtimeStartOptions,
  type StartupOptions,
} from "./runtime-slots/configuration.ts";
import type { RuntimeState } from "./runtime-slots/runtime-state.ts";
import { PoolLifecycle } from "./lifecycle.ts";
import { readRuntimeHealth } from "./runtime-health.ts";
import { poolDatabase } from "./database-settings.ts";
import type { LaunchLedger } from "./launch-ledger.ts";
import { LaunchRefused, type LaunchTarget, type LaunchRecord } from "./launch-contract.ts";

interface PoolRuntimeEnvironment {
  POOL_DATABASE_URL: string;
  POOL_MANAGEMENT_KEY: string;
  POOL_IMAGE_HASH: string;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_CLAUDE_QUOTA_DIAGNOSTIC?: string;
}

export async function createPoolLifecycle(
  ctx: RuntimeState,
  env: PoolRuntimeEnvironment,
  launch?: {
    ledger: LaunchLedger;
    binding: Omit<LaunchTarget, "releaseEpoch">;
    beforeStart?: (record: LaunchRecord, options: StartupOptions) => Promise<void>;
  },
) {
  const container = ctx.container;
  if (!container) throw new Error("Pool container binding is missing");
  if (!env.POOL_DATABASE_URL || !env.POOL_MANAGEMENT_KEY || !env.POOL_IMAGE_HASH) {
    throw new Error("Pool deployment secrets or image revision are missing");
  }
  const input = new TextEncoder().encode(
    JSON.stringify([
      env.POOL_DATABASE_URL,
      env.POOL_MANAGEMENT_KEY,
      env.POOL_IMAGE_HASH,
      env.POOL_APP_SIGNING_KEY,
      env.POOL_APP_SIGNING_KEY_PREVIOUS ?? null,
      poolDatabase.owner,
      ...(env.POOL_CLAUDE_QUOTA_DIAGNOSTIC === "true" ? ["claude-shape-diagnostic"] : []),
    ]),
  );
  const revision = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new PoolLifecycle(
    {
      running: () => container.running,
      start: async (record) => {
        if (
          record &&
          (!launch ||
            record.target.instanceId !== ctx.id.toString() ||
            record.target.imageHash !== env.POOL_IMAGE_HASH ||
            (Object.keys(launch.binding) as (keyof typeof launch.binding)[]).some(
              (key) => record.target[key] !== launch.binding[key],
            ))
        )
          throw new LaunchRefused("bound-runtime-drift");
        const options = runtimeStartOptions(runtimeConfiguration(env));
        if (record) {
          options.env.POOL_LAUNCH_GENERATION = String(record.generation);
          options.env.POOL_LAUNCH_TOKEN = record.token;
        }
        if (record) await launch?.beforeStart?.(record, options);
        container.start(options);
      },
      stop: () => container.destroy(),
      keepAlive: (duration) => container.setInactivityTimeout(duration),
      status: () =>
        readRuntimeHealth(
          container.getTcpPort(8318),
          env.POOL_MANAGEMENT_KEY,
          AbortSignal.timeout(2_000),
        ),
    },
    ctx.storage,
    revision,
    undefined,
    launch?.ledger,
  );
}
