import { join } from "node:path";
import { signPoolToken } from "../../src/pool/token.ts";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { isAcceptancePool } from "../pool-acceptance/types.ts";
import {
  acceptanceCredential,
  acceptanceDevice,
  AcceptanceDeviceRefused,
  acceptanceSigningKey,
} from "../release/acceptance-device.ts";
import { checkoutControllerCode } from "./controller.ts";
import type { DispatchDependencies, DispatchInput, FleetAcceptance } from "./dispatch.ts";
import { FleetLaneRefused, refuse } from "./errors.ts";

// Account and Worker are never inputs: the account is a secret and the Worker is found by its tags.

export const dispatchInput = (env: NodeJS.ProcessEnv): DispatchInput => ({
  mode: env.POOL_FLEET_MODE ?? "",
  go: env.POOL_FLEET_GO ?? "",
  active: env.POOL_FLEET_ACTIVE || undefined,
  key: env.POOL_FLEET_KEY || undefined,
  targetActive: env.POOL_FLEET_TARGET_ACTIVE || undefined,
  ref: env.GITHUB_REF ?? "",
  event: env.GITHUB_EVENT_NAME ?? "",
});

const missing = (why: string, fix: string) => refuse("acceptance-credentials-missing", why, fix);

/**
 * The lane's model calls sign for the release's registered acceptance device, as release acceptance
 * does. Only in a dedicated acceptance pool does it also hold an owner token, to read that pool's
 * accounts and usage, so the records its calls leave are the ones checked. A device in a pool that
 * holds people's work gets no owner token at all: the acceptance runs on the device alone.
 */
export async function acceptanceFromEnvironment(
  env: NodeJS.ProcessEnv,
  mint: typeof signPoolToken = signPoolToken,
): Promise<FleetAcceptance | FleetLaneRefused> {
  try {
    const { pool } = acceptanceDevice(env);
    const device = {
      client: new PoolAcceptanceClient(),
      credential: acceptanceCredential(env),
      model: env.POOL_ACCEPTANCE_MODEL?.trim() || undefined,
    };
    // Never minted for a pool that is not acceptance-named (pool-acceptance/types.ts).
    if (!isAcceptancePool(pool)) return device;
    return {
      ...device,
      access: {
        token: await mint(acceptanceSigningKey(env), {
          pool,
          owner: "acceptance",
          organization: "acceptance",
        }),
        owner: "acceptance",
      },
    };
  } catch (error) {
    if (error instanceof AcceptanceDeviceRefused)
      return missing(`${error.field}: ${error.why}.`, `${error.fix}.`);
    throw error;
  }
}

export async function dependenciesFromEnvironment(
  env: NodeJS.ProcessEnv,
): Promise<DispatchDependencies> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  return {
    cloudflare: { accountId, apiToken: env.CLOUDFLARE_API_TOKEN ?? "", fetch: globalThis.fetch },
    controller: (worker) => ({
      accountId,
      worker,
      signingKey: env.POOL_DEPLOYMENT_KEY ?? "",
      code: checkoutControllerCode,
      directory: join(env.RUNNER_TEMP ?? "", "pool-fleet-operator"),
    }),
    acceptance: await acceptanceFromEnvironment(env),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: (line) => process.stdout.write(`${line}\n`),
  };
}
