import { auditDeployToken } from "./token-audit.ts";

const audit = await auditDeployToken(
  process.env.CLOUDFLARE_API_TOKEN ?? "",
  process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
);
process.stdout.write(`${JSON.stringify(audit)}\n`);
if (
  audit.status !== "active_with_account_token_write" &&
  audit.status !== "active_without_account_token_write"
)
  process.exitCode = 1;
