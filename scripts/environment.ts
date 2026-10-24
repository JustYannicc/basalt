import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appHosting, brand, deployment } from "../brand.ts";
import { catalog } from "../src/catalog/settings.ts";
import { poolFrameworkVersion } from "./pool-app-bundle.ts";
import { isSigningKey } from "../src/pool/token.ts";
import { derivePreviewSecrets, previewKey } from "./release-preview/keys.ts";

export const requiredSecrets = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PLANETSCALE_ORGANIZATION",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_API_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "EXECUTOR_OAUTH_GOOGLE_CLIENT_ID",
  "EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET",
  "EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_ID",
  "EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_SECRET",
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

export const requiredPreviewSecrets = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PLANETSCALE_ORGANIZATION",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_API_TOKEN",
  "TEST_STAGE_DOMAIN",
] as const;

export const requiredPreviewDeploySecrets = [
  ...requiredPreviewSecrets,
  "GOOGLE_CLIENT_ID",
  "AUTH_GITHUB_CLIENT_ID",
] as const;

export const requiredPreviewCleanupSecrets = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PLANETSCALE_ORGANIZATION",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_API_TOKEN",
  "TEST_STAGE_DOMAIN",
] as const;

export interface PreviewEnvironment {
  readonly pullRequest: number;
  readonly stage: string;
  readonly sourceNamespace: string;
  readonly databaseName: string;
  readonly origin: string;
  /** Passed to Alchemy. It contains no production runtime secrets or smoke credentials. */
  readonly deploy: NodeJS.ProcessEnv;
  /** Passed only to the one-shot database seeder. */
  readonly seed: NodeJS.ProcessEnv;
}

export interface PreviewCleanupEnvironment {
  readonly pullRequest: number;
  readonly stage: string;
  readonly sourceNamespace: string;
  readonly databaseName: string;
  readonly origin: string;
  /** Provider credentials and stage identity only. */
  readonly providers: NodeJS.ProcessEnv;
}

export interface PreviewIdentity {
  readonly pullRequest: number;
  readonly stage: string;
  readonly sourceNamespace: string;
  readonly databaseName: string;
  readonly origin: string;
}

const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function previewPullRequest(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("PR number must be a positive integer");
  return value;
}

function previewDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!dnsName.test(domain)) throw new Error("TEST_STAGE_DOMAIN must be a DNS zone name");
  return domain;
}

function previewStateKey(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("PREVIEW_STATE_KEY must be 32 bytes of lowercase hex");
}

function previewSmokeCredentials(source: NodeJS.ProcessEnv): void {
  if (!source.PREVIEW_SMOKE_EMAIL?.trim()) throw new Error("Missing GitHub Actions secret: PREVIEW_SMOKE_EMAIL");
  if (!source.PREVIEW_SMOKE_PASSWORD?.trim()) throw new Error("Missing GitHub Actions secret: PREVIEW_SMOKE_PASSWORD");
  if (!source.PREVIEW_SMOKE_EMAIL.endsWith("@example.invalid"))
    throw new Error("PREVIEW_SMOKE_EMAIL must use the reserved example.invalid domain");
}

export function deployEnvironment(source = process.env): NodeJS.ProcessEnv {
  for (const name of [
    "EXECUTOR_EMULATORS",
    "TEST_STAGE_DATABASE_PROVIDER",
    "TEST_STAGE_PASSWORD_SIGN_IN",
    "CLOUD_SOURCE_NAMESPACE",
    "PREVIEW_STATE_KEY",
    "PREVIEW_SMOKE_EMAIL",
    "PREVIEW_SMOKE_PASSWORD",
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
    DO_NOT_TRACK: "1",
    ALCHEMY_STAGE: deployment.stage,
    CLOUD_SOURCE_NAMESPACE: deployment.sourceNamespace,
    BETTER_AUTH_URL: `https://${brand.host}`,
    EXECUTOR_APP_UI_BASE_URL: appHosting.enabled ? appHosting.origin : undefined,
    EXECUTOR_APP_DOMAIN_ZONE: appHosting.enabled ? appHosting.zone : undefined,
    AUTH_EMAIL_DOMAIN: brand.emailDomain,
    EXECUTOR_PRODUCT_NAME: brand.name,
    EXECUTOR_CATALOG_URL: `https://${brand.host}${catalog.path}index.json`,
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
  };
}

/** Derive one temporary PR environment; production credentials never enter the returned env. */
export function previewEnvironment(
  pullRequest: number,
  source = process.env,
): PreviewEnvironment {
  const number = previewPullRequest(pullRequest);
  const identity = previewIdentity(number, source);
  for (const name of requiredPreviewDeploySecrets) {
    if (!source[name]?.trim()) throw new Error(`Missing GitHub Actions secret: ${name}`);
  }
  if (!source.PREVIEW_STATE_KEY?.trim())
    throw new Error("Missing GitHub Actions secret: PREVIEW_STATE_KEY");
  previewStateKey(source.PREVIEW_STATE_KEY!);
  previewSmokeCredentials(source);

  const slug = `pr-${number}`;
  const { stage, databaseName, origin, sourceNamespace } = identity;
  const domain = previewDomain(source.TEST_STAGE_DOMAIN!);
  const generated = derivePreviewSecrets(source.PREVIEW_STATE_KEY!, number);
  const upstreamCommit = JSON.parse(
    readFileSync(new URL("../upstream.json", import.meta.url), "utf8"),
  ).commit as string;

  const deploy: NodeJS.ProcessEnv = { ...source };
  for (const name of [
    "BETTER_AUTH_SECRET",
    "EXECUTOR_ENCRYPTION_KEY",
    "MCP_SESSION_KEY_CURRENT",
    "MCP_SESSION_KEY_PREVIOUS",
    "APP_DOMAIN_CONTROL_SECRET",
    "POOL_MANAGEMENT_KEY",
    "POOL_APP_SIGNING_KEY",
    "POOL_APP_SIGNING_KEY_PREVIOUS",
    "OAUTH_PROXY_PRODUCTION_URL",
    "OAUTH_PROXY_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_SECRET",
    "AUTH_GITHUB_CLIENT_SECRET",
    "PREVIEW_STATE_KEY",
    "PREVIEW_SMOKE_EMAIL",
    "PREVIEW_SMOKE_PASSWORD",
  ]) delete deploy[name];

  Object.assign(deploy, generated, {
    ALCHEMY_STAGE: stage,
    CI: "true",
    DO_NOT_TRACK: "1",
    CLOUD_SOURCE_NAMESPACE: sourceNamespace,
    TEST_STAGE_DOMAIN: domain,
    TEST_STAGE_DATABASE_PROVIDER: "planetscale",
    TEST_STAGE_DATABASE: databaseName,
    TEST_STAGE_PASSWORD_SIGN_IN: "true",
    BETTER_AUTH_URL: origin,
    AUTH_EMAIL_DOMAIN: `auth.${slug}.${domain}`,
    AUTH_EMAIL_PROVISION_SUBDOMAIN: "false",
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID,
    // Previews use the OAuth application IDs but never its production client secrets.
    GOOGLE_CLIENT_SECRET: previewKey(source.PREVIEW_STATE_KEY!, number, "GOOGLE_CLIENT_SECRET"),
    GITHUB_CLIENT_ID: source.AUTH_GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: previewKey(source.PREVIEW_STATE_KEY!, number, "GITHUB_CLIENT_SECRET"),
    PLANETSCALE_DATABASE_NAME: databaseName,
    PLANETSCALE_ADOPT_DATABASE: "false",
    PLANETSCALE_REGION: deployment.databaseRegion,
    PLANETSCALE_CLUSTER_SIZE: deployment.databaseClusterSize,
    CLOUD_PLACEMENT_REGION: deployment.placementRegion,
    EXECUTOR_BUILD_VERSION: upstreamCommit,
    EXECUTOR_APPS_VERSION: poolFrameworkVersion,
    EXECUTOR_APPS_FRAMEWORK: fileURLToPath(
      new URL("../.upstream/.local/basalt-framework", import.meta.url),
    ),
    CLOUD_DATA_STEPS: "apply",
    SENTRY_ENABLED: "false",
    POSTHOG_ENABLED: "false",
  });
  return {
    ...identity,
    deploy,
    seed: {
      PREVIEW_SMOKE_EMAIL: source.PREVIEW_SMOKE_EMAIL,
      PREVIEW_SMOKE_PASSWORD: source.PREVIEW_SMOKE_PASSWORD,
    },
  };
}

/** Build cleanup config without smoke or runtime application secrets. */
export function previewCleanupEnvironment(
  pullRequest: number,
  source = process.env,
): PreviewCleanupEnvironment {
  const identity = previewIdentity(pullRequest, source);
  for (const name of requiredPreviewCleanupSecrets) {
    if (!source[name]?.trim()) throw new Error(`Missing GitHub Actions secret: ${name}`);
  }
  if (!source.PREVIEW_STATE_KEY?.trim())
    throw new Error("Missing GitHub Actions secret: PREVIEW_STATE_KEY");
  previewStateKey(source.PREVIEW_STATE_KEY);
  return {
    ...identity,
    providers: {
      CI: "true",
      DO_NOT_TRACK: "1",
      CLOUDFLARE_ACCOUNT_ID: source.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: source.CLOUDFLARE_API_TOKEN,
      PLANETSCALE_ORGANIZATION: source.PLANETSCALE_ORGANIZATION,
      PLANETSCALE_API_TOKEN_ID: source.PLANETSCALE_API_TOKEN_ID,
      PLANETSCALE_API_TOKEN: source.PLANETSCALE_API_TOKEN,
      ALCHEMY_STAGE: identity.stage,
      TEST_STAGE_DOMAIN: previewDomain(source.TEST_STAGE_DOMAIN!),
      TEST_STAGE_DATABASE: identity.databaseName,
      PLANETSCALE_DATABASE_NAME: identity.databaseName,
      PLANETSCALE_ADOPT_DATABASE: "false",
      PLANETSCALE_REGION: deployment.databaseRegion,
      PLANETSCALE_CLUSTER_SIZE: deployment.databaseClusterSize,
      CLOUD_SOURCE_NAMESPACE: identity.sourceNamespace,
    },
  };
}

/** Preview addresses use the router's HTTPS scheme and a validated, explicitly supplied zone. */
export function previewStageOrigin(slug: string, domain: string, app = true): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(slug))
    throw new Error("Invalid preview stage slug");
  const zone = previewDomain(domain);
  const url = new URL("/", `https://${brand.host}`);
  url.hostname = `${app ? "app." : ""}${slug}.${zone}`;
  return url.origin;
}

/** Deterministic stage identity; it reads no provider credentials and performs no I/O. */
export function previewIdentity(
  pullRequest: number,
  source = process.env,
): PreviewIdentity {
  const number = previewPullRequest(pullRequest);
  const domain = previewDomain(source.TEST_STAGE_DOMAIN ?? "");
  const slug = `pr-${number}`;
  return {
    pullRequest: number,
    stage: `test-${slug}`,
    sourceNamespace: `basalt-preview-${slug}-apps`,
    databaseName: `basalt-preview-${slug}`,
    origin: previewStageOrigin(slug, domain),
  };
}
