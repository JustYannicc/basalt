import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";

export const WORKFLOW_DRAIN_STEP_NAME =
  "Journal changes require all existing workflow runs drained before deployment";

export const DATABASE_SCOPE = {
  provider: "planetscale-postgres-branch",
  database: "basalt",
  logicalDatabases: ["postgres", "basalt_pool"],
} as const;

const shaPattern = /^[a-f0-9]{40}$/i;
const hashPattern = /^[a-f0-9]{64}$/i;
const basaltBackupPrefix = "basalt-release-";
const legacyBackupPrefix = `${basaltBackupPrefix}v1-`;
const backupPrefix = `${basaltBackupPrefix}v2-`;
const backupDigestPattern = /^[A-Za-z0-9_-]{43}$/;
/** PlanetScale rejected an 880-character v1 name with HTTP 422; its own backup names are about 23 characters. */
export const MAXIMUM_BACKUP_NAME_LENGTH = 64;

export class SafetyGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyGateError";
  }
}

export type PinSummary = {
  tools: { commit: string };
  home: {
    tag: string;
    commit: string;
    binary: string;
    assets: Record<"amd64" | "arm64", { name: string; sha256: string }>;
  };
  node: {
    tag: string;
    commit: string;
    binary: string;
    assets: Record<"amd64" | "arm64", { name: string; sha256: string }>;
  };
};

export type BackupMetadata = {
  schemaVersion: 1;
  base: { gitCommit: string; pins: PinSummary };
  candidate: { gitCommit: string; pins: PinSummary };
  scope: typeof DATABASE_SCOPE & { branch: string };
  branchContext: { clusterSize: string; hasReplicas: boolean };
};

/** A backup name together with the metadata its name digest commits to. */
export type RecordedBackup = { name: string; metadata: BackupMetadata };

/**
 * The backup a manual rollback restores. After a roll-forward it is the failed release's backup:
 * same base, but taken for the failed release's commit, named by `rolledForwardOver`.
 */
export type RollbackBackup = RecordedBackup & { rolledForwardOver?: string };

export type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

type UnknownRecord = Record<string, unknown>;

export function parseClassificationReport(value: unknown): ClassificationReport {
  const report = object(value, "classification report");
  if (report.schemaVersion !== 1) throw new SafetyGateError("Unsupported classification report schema");

  const base = parseReleaseSide(report.base, "base");
  const candidate = parseReleaseSide(report.candidate, "candidate");
  const database = parseEvidence(report.evidence && object(report.evidence, "evidence").database, "database evidence");
  const workflow = parseEvidence(object(report.evidence, "evidence").workflow, "workflow evidence");
  const databaseChanged = boolean(report.databaseChanged, "databaseChanged");
  const workflowChanged = boolean(report.workflowChanged, "workflowChanged");

  if (databaseChanged !== (database.state !== "unchanged"))
    throw new SafetyGateError("databaseChanged disagrees with database evidence; refusing deployment");
  if (workflowChanged !== (workflow.state !== "unchanged"))
    throw new SafetyGateError("workflowChanged disagrees with workflow evidence; refusing deployment");

  return {
    schemaVersion: 1,
    base,
    candidate,
    databaseChanged,
    workflowChanged,
    evidence: { database, workflow },
  };
}

export function parseReportFile(path: string): ClassificationReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SafetyGateError("Classification report file cannot be read or parsed");
  }
  return parseClassificationReport(parsed);
}

export function summarizePins(pins: ReleasePins): PinSummary {
  return {
    tools: { commit: pins.tools.commit },
    home: summarizeArtifact(pins.home),
    node: summarizeArtifact(pins.node),
  };
}

export function parsePinSummary(value: unknown, label = "deployment pins"): PinSummary {
  const pins = object(value, label);
  const tools = object(pins.tools, `${label}.tools`);
  return {
    tools: { commit: sha(tools.commit, `${label}.tools.commit`) },
    home: parseSummaryArtifact(pins.home, `${label}.home`),
    node: parseSummaryArtifact(pins.node, `${label}.node`),
  };
}

export function createBackupMetadata(
  report: ClassificationReport,
  branchName: string,
  branchClusterSize: string,
  branchHasReplicas: boolean,
): BackupMetadata {
  return parseBackupMetadata({
    schemaVersion: 1,
    base: { gitCommit: report.base.gitCommit, pins: summarizePins(report.base.pins) },
    candidate: { gitCommit: report.candidate.gitCommit, pins: summarizePins(report.candidate.pins) },
    scope: { ...DATABASE_SCOPE, branch: nonEmptyString(branchName, "backup branch name") },
    branchContext: { clusterSize: branchClusterSize, hasReplicas: branchHasReplicas },
  });
}

/** The name carries only a digest of the metadata; the GitHub deployment payload records the metadata itself. */
export function backupNameFor(metadata: BackupMetadata): string {
  const name = `${backupPrefix}${backupMetadataDigest(metadata)}`;
  if (name.length > MAXIMUM_BACKUP_NAME_LENGTH)
    throw new SafetyGateError("Release backup name exceeds the provider name limit");
  return name;
}

export function createRecordedBackup(
  report: ClassificationReport,
  branchName: string,
  branchClusterSize: string,
  branchHasReplicas: boolean,
): RecordedBackup {
  const metadata = createBackupMetadata(report, branchName, branchClusterSize, branchHasReplicas);
  return { name: backupNameFor(metadata), metadata };
}

export function createBackupName(
  report: ClassificationReport,
  branchName: string,
  branchClusterSize: string,
  branchHasReplicas: boolean,
): string {
  return createRecordedBackup(report, branchName, branchClusterSize, branchHasReplicas).name;
}

export type BackupNameFormat = { format: "v2" } | { format: "v1"; metadata: BackupMetadata };

/**
 * Undefined for a backup Basalt doesn't own, such as PlanetScale's own. Throws for any malformed
 * `basalt-release-` name, including an unknown version.
 */
export function readBackupName(name: unknown): BackupNameFormat | undefined {
  if (typeof name !== "string" || !name.startsWith(basaltBackupPrefix)) return undefined;
  if (name.startsWith(backupPrefix)) {
    if (!backupDigestPattern.test(name.slice(backupPrefix.length)))
      throw new SafetyGateError("PlanetScale backup name digest is malformed");
    return { format: "v2" };
  }
  if (name.startsWith(legacyBackupPrefix)) return { format: "v1", metadata: decodeLegacyBackupName(name) };
  throw new SafetyGateError("PlanetScale backup name uses an unknown Basalt format");
}

/**
 * Proves `metadata` is what `name` identifies and returns it validated: a v2 name's digest must equal
 * the metadata digest. A legacy v1 name embeds its metadata, so `metadata` may be omitted, and must
 * match when given.
 */
export function verifyBackupMetadata(name: unknown, metadata?: unknown): BackupMetadata {
  const format = readBackupName(name);
  if (!format) throw new SafetyGateError("PlanetScale backup is missing Basalt rollback metadata");
  if (format.format === "v1") {
    if (metadata === undefined) return format.metadata;
    const parsed = parseBackupMetadata(metadata);
    if (stableStringify(parsed) !== stableStringify(format.metadata))
      throw new SafetyGateError("PlanetScale backup metadata does not match its legacy name");
    return parsed;
  }
  if (metadata === undefined) throw new SafetyGateError("Backup reference is missing its rollback metadata");
  const parsed = parseBackupMetadata(metadata);
  if (backupNameFor(parsed) !== name)
    throw new SafetyGateError("PlanetScale backup metadata does not match the digest in its name");
  return parsed;
}

/** Whether recorded backup metadata describes the classified release transition. */
export function backupMatchesReport(metadata: BackupMetadata, report: ClassificationReport): boolean {
  return metadata.base.gitCommit === report.base.gitCommit &&
    metadata.candidate.gitCommit === report.candidate.gitCommit &&
    stableStringify(metadata.base.pins) === stableStringify(summarizePins(report.base.pins)) &&
    stableStringify(metadata.candidate.pins) === stableStringify(summarizePins(report.candidate.pins));
}

function backupMetadataDigest(metadata: BackupMetadata): string {
  return createHash("sha256").update(stableStringify(metadata)).digest("base64url");
}

function decodeLegacyBackupName(name: string): BackupMetadata {
  const encoded = name.slice(legacyBackupPrefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 6000)
    throw new SafetyGateError("PlanetScale backup metadata is malformed");

  let parsed: unknown;
  try {
    const inflated = inflateRawSync(Buffer.from(encoded, "base64url"), { maxOutputLength: 16_384 });
    parsed = JSON.parse(inflated.toString("utf8"));
  } catch {
    throw new SafetyGateError("PlanetScale backup metadata cannot be decoded");
  }
  return parseBackupMetadata(parsed);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as UnknownRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reportDigest(report: ClassificationReport): string {
  return createHash("sha256").update(stableStringify(report)).digest("hex");
}

export function verifyReportBase(report: ClassificationReport, deployed: { gitCommit: string; pins: PinSummary }): void {
  if (report.base.gitCommit !== deployed.gitCommit)
    throw new SafetyGateError("Release classification base is not the latest successful production deploy");
  if (stableStringify(summarizePins(report.base.pins)) !== stableStringify(deployed.pins))
    throw new SafetyGateError("Release classification pins do not match the latest successful production deploy");
}

export function changedSourceReasons(report: ClassificationReport): string[] {
  return [
    ...report.evidence.database.sources,
    ...report.evidence.workflow.sources,
  ].flatMap((source) => source.reason ? [source.reason] : []);
}

function parseReleaseSide(value: unknown, label: string): ClassificationReport["base"] {
  const side = object(value, label);
  const gitCommit = sha(side.gitCommit, `${label}.gitCommit`);
  return { gitCommit, pins: parsePins(side.pins, `${label}.pins`) };
}

function parsePins(value: unknown, label: string): ReleasePins {
  const pins = object(value, label);
  const tools = object(pins.tools, `${label}.tools`);
  const home = parseArtifact(pins.home, `${label}.home`);
  const node = parseArtifact(pins.node, `${label}.node`);
  return {
    tools: {
      repository: nonEmptyString(tools.repository, `${label}.tools.repository`),
      commit: sha(tools.commit, `${label}.tools.commit`),
    },
    home,
    node,
  };
}

function parseArtifact(value: unknown, label: string): ReleasePins["home"] {
  const artifact = object(value, label);
  const assets = object(artifact.assets, `${label}.assets`);
  return {
    repository: nonEmptyString(artifact.repository, `${label}.repository`),
    tag: nonEmptyString(artifact.tag, `${label}.tag`),
    commit: sha(artifact.commit, `${label}.commit`),
    binary: nonEmptyString(artifact.binary, `${label}.binary`),
    assets: {
      amd64: parseAsset(assets.amd64, `${label}.assets.amd64`),
      arm64: parseAsset(assets.arm64, `${label}.assets.arm64`),
    },
  };
}

function parseAsset(value: unknown, label: string): ReleasePins["home"]["assets"]["amd64"] {
  const asset = object(value, label);
  const sha256 = nonEmptyString(asset.sha256, `${label}.sha256`);
  if (!hashPattern.test(sha256)) throw new SafetyGateError(`${label}.sha256 is invalid`);
  return { name: nonEmptyString(asset.name, `${label}.name`), sha256 };
}

function summarizeArtifact(artifact: ReleasePins["home"]): PinSummary["home"] {
  return {
    tag: artifact.tag,
    commit: artifact.commit,
    binary: artifact.binary,
    assets: {
      amd64: { name: artifact.assets.amd64.name, sha256: artifact.assets.amd64.sha256 },
      arm64: { name: artifact.assets.arm64.name, sha256: artifact.assets.arm64.sha256 },
    },
  };
}

function parseEvidence(value: unknown, label: string): ClassificationReport["evidence"]["database"] {
  const evidence = object(value, label);
  if (evidence.state !== "unchanged" && evidence.state !== "changed" && evidence.state !== "unknown")
    throw new SafetyGateError(`${label}.state is invalid`);
  if (!Array.isArray(evidence.sources)) throw new SafetyGateError(`${label}.sources must be an array`);
  const sources = evidence.sources.map((item, index) => {
    const source = object(item, `${label}.sources[${index}]`);
    if (source.state !== "unchanged" && source.state !== "changed" && source.state !== "unknown")
      throw new SafetyGateError(`${label}.sources[${index}].state is invalid`);
    if (!Array.isArray(source.changedPaths) || source.changedPaths.some((path) => typeof path !== "string"))
      throw new SafetyGateError(`${label}.sources[${index}].changedPaths is invalid`);
    const parsed: ClassificationReport["evidence"]["database"]["sources"][number] = {
      name: nonEmptyString(source.name, `${label}.sources[${index}].name`),
      state: source.state,
      base: nonEmptyString(source.base, `${label}.sources[${index}].base`),
      candidate: nonEmptyString(source.candidate, `${label}.sources[${index}].candidate`),
      changedPaths: source.changedPaths as string[],
    };
    if (source.reason !== undefined) parsed.reason = nonEmptyString(source.reason, `${label}.sources[${index}].reason`);
    return parsed;
  });
  return { state: evidence.state, sources };
}

function parseBackupMetadata(value: unknown): BackupMetadata {
  const metadata = object(value, "backup metadata");
  if (metadata.schemaVersion !== 1) throw new SafetyGateError("Unsupported backup metadata schema");
  const base = parseSummarySide(metadata.base, "backup metadata base");
  const candidate = parseSummarySide(metadata.candidate, "backup metadata candidate");
  const scope = object(metadata.scope, "backup scope");
  if (scope.provider !== DATABASE_SCOPE.provider || scope.database !== DATABASE_SCOPE.database)
    throw new SafetyGateError("PlanetScale backup is not scoped to the production database branch");
  const branch = nonEmptyString(scope.branch, "backup scope branch");
  const logicalDatabases = scope.logicalDatabases;
  if (!Array.isArray(logicalDatabases) ||
      !DATABASE_SCOPE.logicalDatabases.every((name) => logicalDatabases.includes(name)) ||
      logicalDatabases.length !== DATABASE_SCOPE.logicalDatabases.length)
    throw new SafetyGateError("PlanetScale backup does not declare both logical databases");
  const branchContext = object(metadata.branchContext, "backup branch context");
  if (typeof branchContext.hasReplicas !== "boolean")
    throw new SafetyGateError("PlanetScale backup replica topology is missing");
  return {
    schemaVersion: 1,
    base,
    candidate,
    scope: { ...DATABASE_SCOPE, branch },
    branchContext: {
      clusterSize: nonEmptyString(branchContext.clusterSize, "backup branch cluster size"),
      hasReplicas: branchContext.hasReplicas,
    },
  };
}

function parseSummarySide(value: unknown, label: string): BackupMetadata["base"] {
  const side = object(value, label);
  const pins = object(side.pins, `${label}.pins`);
  const tools = object(pins.tools, `${label}.pins.tools`);
  return {
    gitCommit: sha(side.gitCommit, `${label}.gitCommit`),
    pins: {
      tools: { commit: sha(tools.commit, `${label}.pins.tools.commit`) },
      home: parseSummaryArtifact(pins.home, `${label}.pins.home`),
      node: parseSummaryArtifact(pins.node, `${label}.pins.node`),
    },
  };
}

function parseSummaryArtifact(value: unknown, label: string): PinSummary["home"] {
  const artifact = object(value, label);
  const assets = object(artifact.assets, `${label}.assets`);
  return {
    tag: nonEmptyString(artifact.tag, `${label}.tag`),
    commit: sha(artifact.commit, `${label}.commit`),
    binary: nonEmptyString(artifact.binary, `${label}.binary`),
    assets: {
      amd64: parseAsset(assets.amd64, `${label}.assets.amd64`),
      arm64: parseAsset(assets.arm64, `${label}.assets.arm64`),
    },
  };
}

function object(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SafetyGateError(`${label} must be an object`);
  return value as UnknownRecord;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SafetyGateError(`${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new SafetyGateError(`${label} must be a boolean`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new SafetyGateError(`${label} must be a 40-character commit SHA`);
  return value.toLowerCase();
}
