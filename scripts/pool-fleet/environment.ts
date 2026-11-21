import { join } from "node:path";
import { signPoolToken } from "../../src/pool/token.ts";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { checkoutControllerCode } from "./controller.ts";
import type { DispatchDependencies, DispatchInput } from "./dispatch.ts";

// Account and Worker are never inputs: the account is a secret and the Worker is found by its tags.

export const dispatchInput = (env: NodeJS.ProcessEnv): DispatchInput => ({
  mode: env.POOL_FLEET_MODE ?? "",
  go: env.POOL_FLEET_GO ?? "",
  active: env.POOL_FLEET_ACTIVE || undefined,
  ref: env.GITHUB_REF ?? "",
  event: env.GITHUB_EVENT_NAME ?? "",
});

export async function dependenciesFromEnvironment(
  env: NodeJS.ProcessEnv,
): Promise<DispatchDependencies> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const pool = env.POOL_ACCEPTANCE_POOL?.trim() ?? "";
  const acceptanceReady =
    env.POOL_ACCEPTANCE_KEY && env.POOL_APP_SIGNING_KEY && /^acceptance-[a-zA-Z0-9-]+$/u.test(pool);
  return {
    cloudflare: { accountId, apiToken: env.CLOUDFLARE_API_TOKEN ?? "", fetch: globalThis.fetch },
    controller: (worker) => ({
      accountId,
      worker,
      signingKey: env.POOL_DEPLOYMENT_KEY ?? "",
      code: checkoutControllerCode,
      directory: join(env.RUNNER_TEMP ?? "", "pool-fleet-operator"),
    }),
    acceptance: acceptanceReady
      ? {
          client: new PoolAcceptanceClient(),
          apiKey: env.POOL_ACCEPTANCE_KEY!,
          model: env.POOL_ACCEPTANCE_MODEL?.trim() || undefined,
          access: {
            token: await signPoolToken(env.POOL_APP_SIGNING_KEY!, {
              pool,
              owner: "acceptance",
              organization: "acceptance",
            }),
            owner: "acceptance",
          },
        }
      : undefined,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: (line) => process.stdout.write(`${line}\n`),
  };
}
