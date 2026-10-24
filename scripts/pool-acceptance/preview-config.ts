import { lstat, readFile } from "node:fs/promises";
import { brand } from "../../brand.ts";
import { AcceptanceFailure, isObject } from "./types.ts";

export interface PreviewConfig {
  origin: string;
  email: string;
  password: string;
  organizationId: string;
  poolAppId: string;
  claudeLogin: Record<string, unknown>;
  codexLogin: Record<string, unknown>;
  codexAuthFile: string;
  models: { claude: string; codex: string };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AcceptanceFailure(`Preview requires ${name}`);
  return value;
}

async function privateJson(path: string): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 1_048_576) {
      throw new Error();
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new AcceptanceFailure("Preview auth files must be private regular JSON files");
  }
}

export async function previewConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<PreviewConfig> {
  const input = required(env, "POOL_ACCEPTANCE_ORIGIN");
  let origin: URL;
  try { origin = new URL(input); }
  catch { throw new AcceptanceFailure("Preview requires an explicit HTTPS origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
    || origin.search || origin.hash || origin.hostname === brand.host) {
    throw new AcceptanceFailure("Preview requires a separate HTTPS origin without a path or credentials");
  }
  const codexAuthFile = required(env, "PREVIEW_CODEX_CLI_AUTH_FILE");
  const [claudeLogin, codexLogin, nativeAuth] = await Promise.all([
    privateJson(required(env, "PREVIEW_CLAUDE_AUTH_FILE")),
    privateJson(required(env, "PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE")),
    privateJson(codexAuthFile),
  ]);
  if (claudeLogin.type !== "claude" || codexLogin.type !== "codex") {
    throw new AcceptanceFailure("Preview subscription files must identify Claude and Codex respectively");
  }
  const tokens = nativeAuth.tokens;
  if (nativeAuth.auth_mode !== "chatgpt" || !isObject(tokens)
    || !["id_token", "access_token", "refresh_token"].every(name =>
      typeof tokens[name] === "string" && tokens[name])) {
    throw new AcceptanceFailure("Preview requires a dedicated native Codex ChatGPT login file");
  }
  return {
    origin: origin.origin,
    email: required(env, "PREVIEW_SMOKE_EMAIL"),
    password: required(env, "PREVIEW_SMOKE_PASSWORD"),
    organizationId: required(env, "PREVIEW_SMOKE_ORGANIZATION_ID"),
    poolAppId: required(env, "PREVIEW_SMOKE_POOL_APP_ID"),
    claudeLogin, codexLogin, codexAuthFile,
    models: { claude: required(env, "PREVIEW_CLAUDE_MODEL"), codex: required(env, "PREVIEW_CODEX_MODEL") },
  };
}
