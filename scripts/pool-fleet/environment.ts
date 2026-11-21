import { join } from "node:path";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { acceptanceCredential, AcceptanceDeviceRefused } from "../release/acceptance-device.ts";
import { checkoutControllerCode } from "./controller.ts";
import type { DispatchDependencies, DispatchInput, FleetAcceptance } from "./dispatch.ts";
import { FleetLaneRefused, refuse } from "./errors.ts";

// Account and Worker are never inputs: the account is a secret and the Worker is found by its tags.

export const dispatchInput = (env: NodeJS.ProcessEnv): DispatchInput => ({
  mode: env.POOL_FLEET_MODE ?? "",
  go: env.POOL_FLEET_GO ?? "",
  active: env.POOL_FLEET_ACTIVE || undefined,
  ref: env.GITHUB_REF ?? "",
  event: env.GITHUB_EVENT_NAME ?? "",
});

const missing = (why: string, fix: string) => refuse("acceptance-credentials-missing", why, fix);

/**
 * The lane's model calls sign for the release's registered acceptance device, as release acceptance
 * does, and the same assertion reads back that device's own usage. It holds no pool token, so the
 * device may stay in whichever pool holds it.
 */
function acceptanceFromEnvironment(env: NodeJS.ProcessEnv): FleetAcceptance | FleetLaneRefused {
  try {
    return {
      client: new PoolAcceptanceClient(),
      credential: acceptanceCredential(env),
      model: env.POOL_ACCEPTANCE_MODEL?.trim() || undefined,
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
    acceptance: acceptanceFromEnvironment(env),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: (line) => process.stdout.write(`${line}\n`),
  };
}
