import { digest } from "../backend-users.ts";
import { historyObject, invalidHistory } from "./record.ts";
import { importAccountMappings, type ImportAccountMapping } from "./import-account-mapping.ts";

export const bulkImportPath = "/pool/v1/usage/import/bulk";
export const maximumBulkRows = 5000;
export const maximumBulkChunkBytes = 8 * 1024 * 1024;
export interface BulkIdentity {
  pool: string;
  organization: string;
  owner: string;
}
export interface BulkChunk {
  sha256: string;
  idsSha256: string;
  rows: number;
  bytes: number;
}
export interface BulkManifest {
  version: 1;
  source: string;
  sourceHash: string;
  approvedManifestSha256: string;
  accountMappingDigest: string;
  totalRows: number;
  chunks: BulkChunk[];
}
export interface BulkDefinition {
  job: string;
  identity: BulkIdentity;
  manifest: BulkManifest;
  manifestDigest: string;
  accountMappingDigest: string;
  accountMappings: ImportAccountMapping[];
}
export interface BulkGuard {
  observedAt: number;
  expiresAt: number;
  ready: boolean;
  cpu: number;
  poolErrors: number;
  queryErrors: number;
}
export interface BulkStatus {
  job: string;
  state: string;
  manifestDigest: string;
  accountMappingDigest: string;
  totalRows: number;
  totalChunks: number;
  uploadedChunks: number;
  committedChunks: number;
  inserted: number;
  existing: number;
  reason: string | null;
}
export function bulkHash(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) return invalidHistory();
  return raw;
}
export function bulkInteger(raw: unknown, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max)
    return invalidHistory();
  return raw;
}
export async function bulkDefinition(
  raw: unknown,
  identity: BulkIdentity,
): Promise<BulkDefinition> {
  const input = historyObject(raw),
    value = historyObject(input.manifest);
  if (
    value.version !== 1 ||
    typeof value.source !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.source) ||
    !Array.isArray(value.chunks) ||
    value.chunks.length < 1 ||
    value.chunks.length > 10_000
  )
    return invalidHistory();
  const chunks = value.chunks.map((rawChunk): BulkChunk => {
    const chunk = historyObject(rawChunk);
    return {
      sha256: bulkHash(chunk.sha256),
      idsSha256: bulkHash(chunk.idsSha256),
      rows: bulkInteger(chunk.rows, 1, maximumBulkRows),
      bytes: bulkInteger(chunk.bytes, 1, maximumBulkChunkBytes),
    };
  });
  const manifest: BulkManifest = {
    version: 1,
    source: value.source,
    sourceHash: bulkHash(value.sourceHash),
    approvedManifestSha256: bulkHash(value.approvedManifestSha256),
    accountMappingDigest: bulkHash(value.accountMappingDigest),
    totalRows: bulkInteger(value.totalRows, 1, 50_000_000),
    chunks,
  };
  if (chunks.reduce((sum, chunk) => sum + chunk.rows, 0) !== manifest.totalRows)
    return invalidHistory();
  const accountMappings = importAccountMappings(input.accountMappings);
  const accountMappingDigest = await digest(JSON.stringify(accountMappings));
  if (manifest.accountMappingDigest !== accountMappingDigest) return invalidHistory();
  const manifestDigest = await digest(JSON.stringify(manifest));
  const job = await digest(JSON.stringify({ identity, manifestDigest, accountMappingDigest }));
  return { job, identity, manifest, manifestDigest, accountMappingDigest, accountMappings };
}
