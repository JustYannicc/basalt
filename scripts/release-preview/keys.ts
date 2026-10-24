import { createHmac } from "node:crypto";

export function previewKey(key: string, pullRequest: number, purpose: string): string {
  if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    throw new Error("Invalid preview state key or pull request");
  }
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`basalt-preview-v1\0${pullRequest}\0${purpose}`).digest("hex");
}

/** Stable across retries of one temporary stage; never reuse the production signing keys. */
export function derivePreviewSecrets(key: string, pullRequest: number): NodeJS.ProcessEnv {
  return Object.fromEntries([
    "BETTER_AUTH_SECRET", "EXECUTOR_ENCRYPTION_KEY", "MCP_SESSION_KEY_CURRENT",
    "MCP_SESSION_KEY_PREVIOUS", "APP_DOMAIN_CONTROL_SECRET", "POOL_MANAGEMENT_KEY", "POOL_APP_SIGNING_KEY",
  ].map(name => [name, previewKey(key, pullRequest, name)]));
}
