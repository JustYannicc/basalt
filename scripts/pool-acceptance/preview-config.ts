import { lstat, readFile } from "node:fs/promises";
import { brand } from "../../brand.ts";
import { AcceptanceFailure, isObject } from "./types.ts";

export interface PreviewBaseConfig {
  origin: string;
  email: string;
  password: string;
  organizationId: string;
  poolAppId: string;
  codexAuthFile: string;
  models: { claude: string; codex: string };
}

export interface PreviewSetupConfig extends PreviewBaseConfig {
  claudeLogin: Record<string, unknown>;
  codexLogin: Record<string, unknown>;
}

export interface PreviewConfig extends PreviewBaseConfig {
  accounts: readonly import("./preview-pool.ts").PreviewSavedAccount[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AcceptanceFailure(`Preview requires ${name}`);
  return value;
}

async function privateJson(
  path: string,
  label = "Preview auth files",
): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 1_048_576) {
      throw new Error();
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new AcceptanceFailure(`${label} must be private regular JSON files`);
  }
}

function trustedStage(env: NodeJS.ProcessEnv): {
  pullRequest: number;
  stage: string;
  hostname: string;
} {
  const raw =
    env.PREVIEW_SMOKE_PULL_REQUEST?.trim() || required(env, "GITHUB_EVENT_PULL_REQUEST_NUMBER");
  const pullRequest = Number(raw);
  if (
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(pullRequest) ||
    (env.GITHUB_EVENT_PULL_REQUEST_NUMBER && env.GITHUB_EVENT_PULL_REQUEST_NUMBER !== raw)
  ) {
    throw new AcceptanceFailure("Preview requires one matching pull request identity");
  }
  const stage = `test-pr-${pullRequest}`;
  if (required(env, "ALCHEMY_STAGE") !== stage)
    throw new AcceptanceFailure("Preview stage does not match its pull request");
  const domain = required(env, "TEST_STAGE_DOMAIN");
  if (
    domain.length > 230 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
  ) {
    throw new AcceptanceFailure("Preview requires the trusted owned test domain");
  }
  return { pullRequest, stage, hostname: `app.pr-${pullRequest}.${domain}` };
}

async function previewBaseConfig(env: NodeJS.ProcessEnv): Promise<PreviewBaseConfig> {
  const input = required(env, "POOL_ACCEPTANCE_ORIGIN");
  let origin: URL;
  try {
    origin = new URL(input);
  } catch {
    throw new AcceptanceFailure("Preview requires an explicit HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.hostname === brand.host
  ) {
    throw new AcceptanceFailure(
      "Preview requires a separate HTTPS origin without a path or credentials",
    );
  }
  const expected = trustedStage(env);
  // Validate the endpoint's components and canonical form before any adapter can use it.
  if (origin.hostname !== expected.hostname || origin.port || input !== origin.origin) {
    throw new AcceptanceFailure("Preview origin does not match the trusted stage router");
  }
  const organizationId = required(env, "PREVIEW_SMOKE_ORGANIZATION_ID");
  const poolAppId = required(env, "PREVIEW_SMOKE_POOL_APP_ID");
  if (env.POOL_ACCEPTANCE_PREVIEW_MANIFEST_FILE) {
    const manifest = await privateJson(
      env.POOL_ACCEPTANCE_PREVIEW_MANIFEST_FILE,
      "Preview manifests",
    );
    if (
      manifest.version !== 1 ||
      manifest.phase !== "seeded" ||
      manifest.pullRequest !== expected.pullRequest ||
      manifest.stage !== expected.stage ||
      manifest.origin !== origin.origin ||
      manifest.organizationId !== organizationId ||
      manifest.poolAppId !== poolAppId
    ) {
      throw new AcceptanceFailure("Preview manifest does not match the trusted seeded stage");
    }
  }
  // The trusted workflow supplies the PR/stage/domain. Check them before opening credentials.
  const codexAuthFile = required(env, "PREVIEW_CODEX_CLI_AUTH_FILE");
  const nativeAuth = await privateJson(codexAuthFile);
  const tokens = nativeAuth.tokens;
  if (
    nativeAuth.auth_mode !== "chatgpt" ||
    !isObject(tokens) ||
    !["id_token", "access_token", "refresh_token"].every(
      (name) => typeof tokens[name] === "string" && tokens[name],
    )
  ) {
    throw new AcceptanceFailure("Preview requires a dedicated native Codex ChatGPT login file");
  }
  return {
    origin: origin.origin,
    email: required(env, "PREVIEW_SMOKE_EMAIL"),
    password: required(env, "PREVIEW_SMOKE_PASSWORD"),
    organizationId,
    poolAppId,
    codexAuthFile,
    models: {
      claude: required(env, "PREVIEW_CLAUDE_MODEL"),
      codex: required(env, "PREVIEW_CODEX_MODEL"),
    },
  };
}

export async function previewConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreviewConfig> {
  const setup = await previewBaseConfig(env);
  const saved = await privateJson(
    required(env, "POOL_ACCEPTANCE_ACCOUNTS_FILE"),
    "Preview account manifests",
  );
  if (
    saved.version !== 1 ||
    saved.origin !== setup.origin ||
    saved.organizationId !== setup.organizationId ||
    saved.poolAppId !== setup.poolAppId ||
    !Array.isArray(saved.accounts) ||
    saved.accounts.length !== 2 ||
    !saved.accounts.every(
      (account: unknown) =>
        isObject(account) &&
        typeof account.id === "string" &&
        /^acc_[A-Za-z0-9_-]+$/.test(account.id) &&
        ["openai", "anthropic"].includes(String(account.requirement)),
    )
  )
    throw new AcceptanceFailure("Preview account manifest does not match the seeded stage");
  const accounts = saved.accounts as PreviewConfig["accounts"];
  if (
    new Set(accounts.map((account) => account.id)).size !== 2 ||
    new Set(accounts.map((account) => account.requirement)).size !== 2
  )
    throw new AcceptanceFailure(
      "Preview account manifest must contain two distinct provider accounts",
    );
  return { ...setup, accounts };
}

export async function previewSetupConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreviewSetupConfig> {
  const base = await previewBaseConfig(env);
  const [claudeLogin, codexLogin] = await Promise.all([
    privateJson(required(env, "PREVIEW_CLAUDE_AUTH_FILE")),
    privateJson(required(env, "PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE")),
  ]);
  if (claudeLogin.type !== "claude" || codexLogin.type !== "codex")
    throw new AcceptanceFailure(
      "Preview subscription files must identify Claude and Codex respectively",
    );
  return { ...base, claudeLogin, codexLogin };
}
