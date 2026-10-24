import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { appHosting, brand, deployment } from "../brand.ts";
import { poolFrameworkVersion } from "./pool-app-bundle.ts";
import { isSigningKey } from "../src/pool/token.ts";

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
  "POOL_APP_SIGNING_KEY",
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
  if (!isSigningKey(source.POOL_APP_SIGNING_KEY!))
    throw new Error("POOL_APP_SIGNING_KEY must be 32 bytes of lowercase hex");
  // Validated as deployed: the Worker reads the secret as it is, without trimming.
  const previousSigningKey = source.POOL_APP_SIGNING_KEY_PREVIOUS;
  if (previousSigningKey?.trim() && !isSigningKey(previousSigningKey))
    throw new Error("POOL_APP_SIGNING_KEY_PREVIOUS must be 32 bytes of lowercase hex");
  if (previousSigningKey === source.POOL_APP_SIGNING_KEY)
    throw new Error("POOL_APP_SIGNING_KEY_PREVIOUS must differ from POOL_APP_SIGNING_KEY");
  if (appHosting.enabled && !source.APP_DOMAIN_CONTROLLER_TOKEN?.trim()) {
    throw new Error("Missing GitHub Actions secret: APP_DOMAIN_CONTROLLER_TOKEN");
  }
  const { commit } = JSON.parse(readFileSync(new URL("../upstream.json", import.meta.url), "utf8"));
  return {
    ...source,
    CI: "true",
    DO_NOT_TRACK: source.POSTHOG_PROJECT_KEY?.trim() ? "0" : "1",
    ALCHEMY_STAGE: deployment.stage,
    CLOUD_SOURCE_NAMESPACE: deployment.sourceNamespace,
    BETTER_AUTH_URL: `https://${brand.host}`,
    EXECUTOR_APP_UI_BASE_URL: appHosting.enabled ? appHosting.origin : undefined,
    EXECUTOR_APP_DOMAIN_ZONE: appHosting.enabled ? appHosting.zone : undefined,
    AUTH_EMAIL_DOMAIN: brand.emailDomain,
    EXECUTOR_PRODUCT_NAME: brand.name,
    EXECUTOR_PRODUCT_LOGO_URL: brand.logo,
    EXECUTOR_PRODUCT_DOCS_URL: brand.links.docs ?? undefined,
    EXECUTOR_PRODUCT_PRIVACY_URL: brand.links.privacy ?? undefined,
    EXECUTOR_PRODUCT_TERMS_URL: brand.links.terms ?? undefined,
    AUTH_EMAIL_PROVISION_SUBDOMAIN: "false",
    GITHUB_CLIENT_ID: source.AUTH_GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: source.AUTH_GITHUB_CLIENT_SECRET,
    PLANETSCALE_DATABASE_NAME: deployment.databaseName,
    PLANETSCALE_ADOPT_DATABASE: "true",
    PLANETSCALE_REGION: deployment.databaseRegion,
    PLANETSCALE_CLUSTER_SIZE: deployment.databaseClusterSize,
    CLOUD_PLACEMENT_REGION: deployment.placementRegion,
    EXECUTOR_BUILD_VERSION: commit,
    EXECUTOR_APPS_VERSION: poolFrameworkVersion,
    EXECUTOR_APPS_FRAMEWORK: fileURLToPath(
      new URL("../.upstream/.local/basalt-framework", import.meta.url),
    ),
    CLOUD_DATA_STEPS: "apply",
    SENTRY_ENABLED: "false",
    POSTHOG_ENABLED: "false",
    // Separate purpose from pool signatures without another operator-managed secret.
    TELEMETRY_RELAY_KEY: createHash("sha256").update(`basalt-telemetry-v1:${source.POOL_APP_SIGNING_KEY}`).digest("hex"),
    EXECUTOR_TELEMETRY_RELAY_URL: `https://${brand.host}/__telemetry/v1`,
    EXECUTOR_TELEMETRY_RELAY_TOKEN: createHash("sha256").update(`basalt-telemetry-v1:${source.POOL_APP_SIGNING_KEY}`).digest("hex"),
  };
}
