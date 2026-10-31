import { PoolLifecycle } from "./lifecycle.ts";
import { readRuntimeHealth } from "./runtime-health.ts";

interface PoolRuntimeEnvironment {
  POOL_DATABASE_URL: string;
  POOL_MANAGEMENT_KEY: string;
  POOL_IMAGE_HASH: string;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
}

export async function createPoolLifecycle(ctx: DurableObjectState, env: PoolRuntimeEnvironment) {
  const container = ctx.container;
  if (!container) throw new Error("Pool container binding is missing");
  if (!env.POOL_DATABASE_URL || !env.POOL_MANAGEMENT_KEY || !env.POOL_IMAGE_HASH) {
    throw new Error("Pool deployment secrets or image revision are missing");
  }
  const input = new TextEncoder().encode(JSON.stringify([
    env.POOL_DATABASE_URL, env.POOL_MANAGEMENT_KEY, env.POOL_IMAGE_HASH,
    env.POOL_APP_SIGNING_KEY, env.POOL_APP_SIGNING_KEY_PREVIOUS ?? null,
  ]));
  const revision = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new PoolLifecycle({
    running: () => container.running,
    start: () => container.start({
      enableInternet: true,
      env: {
        POOL_DATABASE_URL: env.POOL_DATABASE_URL,
        POOL_MANAGEMENT_KEY: env.POOL_MANAGEMENT_KEY,
        POOL_MANAGEMENT_ALLOW_REMOTE: "true",
        POOL_APP_SIGNING_KEY: env.POOL_APP_SIGNING_KEY,
        ...(env.POOL_APP_SIGNING_KEY_PREVIOUS ? { POOL_APP_SIGNING_KEY_PREVIOUS: env.POOL_APP_SIGNING_KEY_PREVIOUS } : {}),
      },
    }),
    stop: () => container.destroy(),
    keepAlive: (duration) => container.setInactivityTimeout(duration),
    status: () => readRuntimeHealth(container.getTcpPort(8318), env.POOL_MANAGEMENT_KEY, AbortSignal.timeout(2_000)),
  }, ctx.storage, revision);
}
