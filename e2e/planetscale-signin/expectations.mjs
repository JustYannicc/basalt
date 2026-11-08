import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registrationDefault } from "./service.mjs";
/** The hosted app's reviewed permissions; the hosted client must ask for exactly these. */
export const hostedScopes = [
  "read_user",
  "read_organization",
  "write_organization",
  "read_databases",
  "write_databases",
  "organization:create_databases",
  "organization:delete_databases",
  "organization:read_databases",
  "organization:write_databases",
  "organization:read_branches",
  "organization:write_branches",
  "organization:delete_branches",
  "organization:read_deploy_requests",
  "organization:write_deploy_requests",
  "organization:approve_deploy_requests",
  "organization:deploy_deploy_requests",
  "organization:read_backups",
  "organization:write_backups",
  "organization:delete_backups",
  "organization:restore_backups",
  "organization:manage_passwords",
  "organization:manage_read_only_passwords",
  "organization:read_workflows",
  "organization:write_workflows",
  "organization:read_audit_logs",
  "user:read_organizations",
  "organization:promote_branches",
  "database:demote_branches",
  "organization:write_members",
  "organization:manage_sso",
  "organization:read_payment_method",
  "organization:write_payment_method",
  "organization:read_invoices",
];
export const sorted = (values) => [...values].sort();
export const legacyOperations = JSON.parse(
  await readFile(join(import.meta.dirname, "legacy-operations.json"), "utf8"),
);
export const legacyNames = legacyOperations.map((operation) => operation.name);
export const api = legacyOperations
  .filter((operation) => operation.oauthScopes.length > 0)
  .map((operation) => operation.name);
export const tokenOnly = legacyOperations
  .filter((operation) => operation.oauthScopes.length === 0)
  .map((operation) => `serviceToken.${operation.name}`);
export const limited = legacyOperations
  .filter((operation) => operation.oauthScopes.some((scope) => registrationDefault.includes(scope)))
  .map((operation) => operation.name);
