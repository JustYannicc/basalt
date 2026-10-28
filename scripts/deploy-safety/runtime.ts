import { SafetyGateError } from "./contracts.ts";
import type { CloudflareCredentials } from "./cloudflare.ts";
import type { LedgerEnvironment } from "./github-ledger.ts";
import type { PlanetScaleCredentials } from "./planetscale-api.ts";

export type DeploySafetyEnvironment = {
  github: LedgerEnvironment;
  cloudflare: CloudflareCredentials;
  planetscale: PlanetScaleCredentials;
};

export function requireGithubEnvironment(source = process.env): LedgerEnvironment {
  const token = source.GITHUB_TOKEN;
  const repository = source.GITHUB_REPOSITORY;
  if (!token?.trim()) throw new SafetyGateError("Missing GitHub Actions GITHUB_TOKEN");
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new SafetyGateError("GITHUB_REPOSITORY must identify the current repository");
  return { token, repository };
}

export function requireCloudflareEnvironment(source = process.env): CloudflareCredentials {
  const accountId = source.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = source.CLOUDFLARE_API_TOKEN;
  if (!accountId?.trim() || !apiToken?.trim())
    throw new SafetyGateError("Missing Cloudflare production credentials");
  return { accountId, apiToken };
}

export function requirePlanetScaleEnvironment(source = process.env): PlanetScaleCredentials {
  const organization = source.PLANETSCALE_ORGANIZATION;
  const tokenId = source.PLANETSCALE_API_TOKEN_ID;
  const token = source.PLANETSCALE_API_TOKEN;
  if (!organization?.trim() || !tokenId?.trim() || !token?.trim())
    throw new SafetyGateError("Missing PlanetScale production service-token credentials");
  return { organization, tokenId, token };
}

export function requireDeploySafetyEnvironment(source = process.env): DeploySafetyEnvironment {
  return {
    github: requireGithubEnvironment(source),
    cloudflare: requireCloudflareEnvironment(source),
    planetscale: requirePlanetScaleEnvironment(source),
  };
}

/**
 * Stops every release while someone restores a backup and rolls back. Set the `PRODUCTION_RELEASE_HOLD`
 * repository variable to any value first, restore, dispatch the rollback, then clear it. Release
 * jobs receive it; rollback jobs don't, so a rollback still runs. Its value isn't printed.
 */
export function assertNoReleaseHold(source = process.env): void {
  if (source.PRODUCTION_RELEASE_HOLD?.trim())
    throw new SafetyGateError("Production releases are on hold: PRODUCTION_RELEASE_HOLD is set. Clear it once the manual restore and rollback have finished");
}
