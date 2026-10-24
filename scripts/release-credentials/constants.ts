export const credentialSecretNames = {
  claude: "PREVIEW_CLAUDE_AUTH_JSON",
  codex: "PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON",
} as const;

export const maxExportBytes = 1_048_576;
export const maxGitHubSecretBytes = 48 * 1024;
export const exportTimeoutMs = 20_000;
export const secretWriteTimeoutMs = 20_000;
export const secretKillGraceMs = 1_000;
