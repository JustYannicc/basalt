import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  productionStage,
  productZone,
  testStagePrefix,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/stage.ts";

export const smokeUserName = "Preview smoke";

export interface PreviewAuthSeed {
  readonly version: 1;
  readonly stage: string;
  readonly origin: string;
  readonly userId: string;
  readonly organization: { readonly id: string; readonly slug: string };
  readonly poolAppId: string;
}

export interface PreviewProof {
  readonly stage: string;
  readonly origin: string;
  readonly slug: string;
  readonly email: string;
  readonly password: string;
}

export interface PreviewDatabaseProof extends PreviewProof {
  readonly databaseName: string;
  readonly databaseUsername: string;
  readonly databaseUrl: string;
}

const stageSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error("Missing preview auth input");
  return value;
};

/** Confirm that the job is bound to the exact isolated test stage and its database branch. */
export function previewProof(env: NodeJS.ProcessEnv, needsDatabase: true): PreviewDatabaseProof;
export function previewProof(env: NodeJS.ProcessEnv, needsDatabase: false): PreviewProof;
export function previewProof(
  env: NodeJS.ProcessEnv,
  needsDatabase: boolean,
): PreviewProof | PreviewDatabaseProof {
  const stage = required(env, "ALCHEMY_STAGE");
  if (
    stage === productionStage ||
    !stage.startsWith(testStagePrefix) ||
    !stageSlugPattern.test(stage.slice(testStagePrefix.length))
  )
    throw new Error("Unsafe preview stage");

  const slug = stage.slice(testStagePrefix.length);
  const domain = env.TEST_STAGE_DOMAIN ?? "executor.engineering";
  if (
    domain.length === 0 ||
    domain.includes("/") ||
    domain.includes(":") ||
    domain === productZone ||
    domain.endsWith(`.${productZone}`)
  )
    throw new Error("Unsafe preview domain");
  let domainUrl: URL;
  try {
    domainUrl = new URL(`https://${domain}`);
  } catch {
    throw new Error("Unsafe preview domain");
  }
  if (domainUrl.hostname !== domain || domainUrl.pathname !== "/")
    throw new Error("Unsafe preview domain");

  const origin = `https://app.${slug}.${domain}`;
  const configuredOrigin = required(env, "BETTER_AUTH_URL");
  let configured: URL;
  try {
    configured = new URL(configuredOrigin);
  } catch {
    throw new Error("Preview origin does not match its stage");
  }
  if (configuredOrigin !== origin || configured.origin !== configuredOrigin)
    throw new Error("Preview origin does not match its stage");

  const email = required(env, "PREVIEW_SMOKE_EMAIL");
  const password = required(env, "PREVIEW_SMOKE_PASSWORD");
  if (email !== email.trim() || !/^[^@\s]+@example\.invalid$/i.test(email) || password.length < 16)
    throw new Error("Preview credentials must use the reserved smoke identity");

  const proof: PreviewProof = { stage, origin, slug, email, password };
  if (!needsDatabase) return proof;

  const databaseUrl = required(env, "DATABASE_URL");
  const databaseBranch = required(env, "TEST_STAGE_DATABASE_BRANCH");
  const databaseName = required(env, "TEST_STAGE_DATABASE_NAME");
  const databaseUsername = required(env, "TEST_STAGE_DATABASE_USERNAME");
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error("Invalid preview database URL");
  }
  if (
    databaseBranch !== stage ||
    (database.protocol !== "postgres:" && database.protocol !== "postgresql:") ||
    database.searchParams.get("sslmode") !== "verify-full" ||
    decodeURIComponent(database.pathname.slice(1)) !== databaseName ||
    decodeURIComponent(database.username) !== databaseUsername ||
    database.hostname === productZone ||
    database.hostname.endsWith(`.${productZone}`)
  )
    throw new Error("Preview database does not match its stage proof");

  return { ...proof, databaseUrl, databaseName, databaseUsername };
}

export async function readSeed(env: NodeJS.ProcessEnv): Promise<PreviewAuthSeed> {
  const path = required(env, "PREVIEW_AUTH_SEED_OUTPUT");
  if (!isAbsolute(path)) throw new Error("Seed output path must be absolute");
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid preview auth seed output");
  const value = raw as Record<string, unknown>;
  const organization = value.organization;
  if (
    value.version !== 1 ||
    typeof value.stage !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.poolAppId !== "string" ||
    typeof organization !== "object" ||
    organization === null ||
    typeof (organization as Record<string, unknown>).id !== "string" ||
    typeof (organization as Record<string, unknown>).slug !== "string"
  )
    throw new Error("Invalid preview auth seed output");

  return value as unknown as PreviewAuthSeed;
}

export function assertSeedMatchesProof(seed: PreviewAuthSeed, proof: PreviewProof): void {
  if (seed.version !== 1 || seed.stage !== proof.stage || seed.origin !== proof.origin)
    throw new Error("Seed output does not match the preview stage");
}

export function responseCookies(response: Response): string {
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter((cookie) => cookie.includes("=") && !cookie.endsWith("="));
  if (cookies.length === 0) throw new Error("Sign-in returned no session cookie");
  return cookies.join("; ");
}

export async function requireOk(response: Response): Promise<void> {
  if (!response.ok) throw new Error("Preview auth request failed");
}
