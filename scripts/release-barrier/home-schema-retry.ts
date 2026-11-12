import { BarrierRefusal } from "./refusal.ts";
import type {
  HomeMigrationIdentity,
  HomeMigrationReceipt,
  HomeSchemaInfo,
  HomeSchemaResult,
} from "./home-schema-operation.ts";

const intentPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const validHomeRetryIntent = (value: string) => intentPattern.test(value);

/** Only the existing main-only manual dispatch can supply an operator's exact failure acknowledgement. */
export function homeSchemaRetryAuthorization(source: {
  BASALT_HOME_SCHEMA_RETRY_INTENT?: string;
  GITHUB_EVENT_NAME?: string;
  GITHUB_REF?: string;
}) {
  const intent = source.BASALT_HOME_SCHEMA_RETRY_INTENT?.trim();
  if (!intent) return undefined;
  if (
    !validHomeRetryIntent(intent) ||
    source.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    source.GITHUB_REF !== "refs/heads/main"
  )
    throw new BarrierRefusal("home-schema-retry-authorization-invalid", "home");
  return intent;
}

export function changedHomeMigrationConditions(
  identity: HomeMigrationIdentity,
  info: HomeSchemaInfo,
  before: HomeSchemaResult,
  failure: HomeMigrationReceipt,
) {
  if (
    identity.imageDigest !== failure.imageDigest ||
    identity.imageConfigDigest !== failure.imageConfigDigest ||
    identity.sourceInputHash !== failure.sourceInputHash ||
    identity.baselineInputHash !== failure.baselineInputHash ||
    identity.baselineImageDigest !== failure.baselineImageDigest ||
    info.target_version !== failure.targetVersion ||
    info.required_indexes.length !== failure.expectedIndexes.length ||
    info.required_indexes.some((name) => !failure.expectedIndexes.includes(name))
  )
    return true;
  const after = failure.after;
  if (!after || after.applied_version === null) return false;
  if (before.applied_version !== after.applied_version) return true;
  return (
    before.indexes_checked &&
    after.indexes_checked &&
    (before.pending_indexes.length !== after.pending_indexes.length ||
      before.pending_indexes.some((name) => !after.pending_indexes.includes(name)))
  );
}
