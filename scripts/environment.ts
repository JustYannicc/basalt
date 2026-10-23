import { readFileSync } from "node:fs";
import { appHosting, brand, deployment } from "../brand.ts";

export const requiredSecrets = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PLANETSCALE_ORGANIZATION",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_API_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_GITHUB_CLIENT_ID",
  "AUTH_GITHUB_CLIENT_SECRET",
  "BETTER_AUTH_SECRET",
  "EXECUTOR_ENCRYPTION_KEY",
  "MCP_SESSION_KEY_CURRENT",
  "MCP_SESSION_KEY_PREVIOUS",
  "APP_DOMAIN_CONTROL_SECRET",
  "POOL_MANAGEMENT_KEY",
] as const;

export function deployEnvironment(source = process.env): NodeJS.ProcessEnv {
  for (const name of [
    "EXECUTOR_EMULATORS",
    "TEST_STAGE_DATABASE_PROVIDER",
    "EXECUTOR_ROLE_HOSTS_DOMAIN",
  ]) {
    if (source[name]?.trim()) throw new Error(`Unsupported production override: ${name}`);
  }
  for (const name of requiredSecrets) {
    if (!source[name]?.trim()) throw new Error(`Missing GitHub Actions secret: ${name}`);
  }
  if (appHosting.enabled && !source.APP_DOMAIN_CONTROLLER_TOKEN?.trim()) {
    throw new Error("Missing GitHub Actions secret: APP_DOMAIN_CONTROLLER_TOKEN");
  }
  const { commit } = JSON.parse(readFileSync(new URL("../upstream.json", import.meta.url), "utf8"));
  return {
    ...source,
    CI: "true",
    DO_NOT_TRACK: "1",
    ALCHEMY_STAGE: deployment.stage,
    CLOUD_SOURCE_NAMESPACE: deployment.sourceNamespace,
    BETTER_AUTH_URL: `https://${brand.host}`,
    EXECUTOR_APP_UI_BASE_URL: appHosting.enabled ? appHosting.origin : undefined,
    EXECUTOR_APP_DOMAIN_ZONE: appHosting.enabled ? appHosting.zone : undefined,
    AUTH_EMAIL_DOMAIN: brand.emailDomain,
    EXECUTOR_PRODUCT_NAME: brand.name,
    EXECUTOR_PRODUCT_LOGO_URL: brand.logo,
    AUTH_EMAIL_PROVISION_SUBDOMAIN: "false",
    GITHUB_CLIENT_ID: source.AUTH_GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: source.AUTH_GITHUB_CLIENT_SECRET,
    PLANETSCALE_DATABASE_NAME: deployment.databaseName,
    PLANETSCALE_ADOPT_DATABASE: "true",
    PLANETSCALE_REGION: deployment.databaseRegion,
    PLANETSCALE_CLUSTER_SIZE: deployment.databaseClusterSize,
    CLOUD_PLACEMENT_REGION: deployment.placementRegion,
    EXECUTOR_BUILD_VERSION: commit,
    CLOUD_DATA_STEPS: "apply",
    SENTRY_ENABLED: "false",
    POSTHOG_ENABLED: "false",
  };
}
