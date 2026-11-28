import { join } from "node:path";
import { signPoolToken } from "../../src/pool/token.ts";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import {
  acceptanceCredential,
  AcceptanceDeviceRefused,
  acceptanceSigningKey,
} from "../release/acceptance-device.ts";
import {
  acceptanceIdentity,
  acceptanceTestDevice,
  isAcceptanceIdentity,
  testDeviceSecret,
} from "../release/acceptance-test-device.ts";
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
 * The lane's model calls sign for one registered device, chosen by the run's `device` input: the
 * release's own (`release`, the default) or the test pool's (`test`). Each is read from its own
 * secret only; an unset one is refused, never replaced by the other. The test pool is exactly the
 * pool the test device's secret names. Only when that device's user, owner and organization are
 * all the acceptance identity does the lane also hold an owner token, to read the pool's accounts
 * and usage; otherwise, and always with the release's device, it proves usage by the device's own
 * read alone and mints nothing.
 */
/** The owner token outlives the lane's job, whose timeout is 30 minutes, and nothing after it. */
export const ownerTokenLifetimeSeconds = 35 * 60;

export async function acceptanceFromEnvironment(
  env: NodeJS.ProcessEnv,
  mint: typeof signPoolToken = signPoolToken,
  now: () => number = Date.now,
): Promise<FleetAcceptance | FleetLaneRefused> {
  const choice = env.POOL_FLEET_DEVICE?.trim() || "release";
  if (choice !== "release" && choice !== "test")
    return refuse(
      "acceptance-device-invalid",
      "The device input must be release or test.",
      "Pick release or test.",
    );
  const model = env.POOL_ACCEPTANCE_MODEL?.trim() || undefined;
  try {
    if (choice === "release")
      return {
        client: new PoolAcceptanceClient(),
        credential: acceptanceCredential(env),
        model,
        device: "release",
      };
    const test = acceptanceTestDevice(env);
    const device = {
      client: new PoolAcceptanceClient(),
      credential: acceptanceCredential(env, Date.now, testDeviceSecret),
      model,
      device: "test" as const,
    };
    if (!isAcceptanceIdentity(test)) return device;
    return {
      ...device,
      access: {
        token: await mint(acceptanceSigningKey(env), {
          pool: test.pool,
          owner: acceptanceIdentity,
          organization: acceptanceIdentity,
          exp: Math.floor(now() / 1000) + ownerTokenLifetimeSeconds,
        }),
        owner: acceptanceIdentity,
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
