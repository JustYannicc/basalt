import { exportPreviewCredentials, safeCredentialExportMessage, type ExportInputs } from "./export.ts";

const input: ExportInputs = {
  ref: process.env.GITHUB_REF ?? "",
  eventName: process.env.GITHUB_EVENT_NAME ?? "",
  dedicatedThrowawayAccounts: process.env.CREDENTIAL_DEDICATED_THROWAWAY_ACCOUNTS ?? "",
  poolId: process.env.CREDENTIAL_POOL_ID ?? "",
  organizationId: process.env.CREDENTIAL_ORGANIZATION_ID ?? "",
  ownerId: process.env.CREDENTIAL_OWNER_ID ?? "",
  claudeAccountId: process.env.CREDENTIAL_CLAUDE_ACCOUNT_ID ?? "",
  codexAccountId: process.env.CREDENTIAL_CODEX_ACCOUNT_ID ?? "",
  signingKey: process.env.POOL_APP_SIGNING_KEY ?? "",
  releaseToken: process.env.RELEASE_UPDATE_TOKEN ?? "",
  repository: process.env.GITHUB_REPOSITORY ?? "",
};

try {
  await exportPreviewCredentials(input);
} catch (error) {
  process.stderr.write(`${safeCredentialExportMessage(error)}\n`);
  process.exitCode = 1;
}
