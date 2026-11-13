import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { metadataInput, metadataLines, fileDigest } from "./usage-import-stream.ts";
import { serviceOrigin } from "./usage-import-source.ts";
import { historyObject } from "../src/pool/model-history/record.ts";
import { parseBulkUsageImport } from "../src/pool/model-history/import.ts";
import { importAccountMappings } from "../src/pool/model-history/import-account-mapping.ts";
import {
  bulkDefinition,
  maximumBulkRows,
  maximumBulkChunkBytes,
  type BulkDefinition,
  type BulkGuard,
  type BulkManifest,
  type BulkStatus,
} from "../src/pool/model-history/bulk-contract.ts";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface BulkFiles {
  file: string;
  acceptedManifest: string;
  acceptedSha256: string;
  accountMapFile?: string;
  target: string;
  caller: string;
  organization: string;
  pool: string;
  source: string;
}
export interface BulkDescriptor {
  version: 1;
  files: BulkFiles;
  definition: BulkDefinition;
}
export class BulkCliError extends Error {}
const fail = (message: string): never => {
  throw new BulkCliError(message);
};
export async function privateJson(path: string, limit: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0)
    return fail("JSON input must be private and bounded");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
function filesInput(raw: unknown): BulkFiles {
  const value = historyObject(raw);
  for (const key of [
    "file",
    "acceptedManifest",
    "acceptedSha256",
    "target",
    "caller",
    "organization",
    "pool",
    "source",
  ])
    if (typeof value[key] !== "string" || !value[key]) fail("Missing descriptor input");
  if (value.accountMapFile !== undefined && typeof value.accountMapFile !== "string")
    fail("Invalid account map path");
  const text = (key: string) => String(value[key]);
  if (!/^[a-f0-9]{64}$/.test(text("acceptedSha256"))) fail("Invalid accepted manifest digest");
  return {
    file: resolve(text("file")),
    acceptedManifest: resolve(text("acceptedManifest")),
    acceptedSha256: text("acceptedSha256"),
    ...(value.accountMapFile === undefined
      ? {}
      : { accountMapFile: resolve(String(value.accountMapFile)) }),
    target: serviceOrigin(text("target")).origin,
    caller: text("caller"),
    organization: text("organization"),
    pool: text("pool"),
    source: text("source"),
  };
}
async function inputs(files: BulkFiles) {
  if ((await fileDigest(files.acceptedManifest)) !== files.acceptedSha256)
    fail("Accepted manifest digest changed");
  const source = await metadataInput(files.file);
  const sourceHash = await source.digest();
  const mapRaw =
    files.accountMapFile === undefined
      ? undefined
      : await (async () => {
          await privateJson(files.accountMapFile!, 1_048_576);
          return readFile(files.accountMapFile!, "utf8");
        })();
  const accountMappings = importAccountMappings(
    mapRaw === undefined ? undefined : JSON.parse(mapRaw),
  );
  const header = {
    version: 1,
    target: files.target,
    caller: files.caller,
    source: files.source,
    sourceHash,
    format: "cpamp-v1-jsonl",
    ...(mapRaw === undefined ? {} : { accountMapHash: hash(mapRaw), accountMappings }),
  };
  return { source, sourceHash, mapRaw, accountMappings, header };
}

/** Reconstructs bounded chunks; the accepted original pages remain the authority for every ID. */
export async function* bulkChunks(files: BulkFiles) {
  const input = await inputs(files);
  yield* checkedChunks(files, input);
}
async function* checkedChunks(files: BulkFiles, input: Awaited<ReturnType<typeof inputs>>) {
  const approved = metadataLines(files.acceptedManifest)[Symbol.asyncIterator]();
  const seen = new DatabaseSync("");
  seen.exec("PRAGMA cache_size=-4096; CREATE TABLE ids(id TEXT PRIMARY KEY) WITHOUT ROWID");
  const retain = seen.prepare("INSERT INTO ids(id) VALUES (?)");
  let pages = 0,
    data: string[] = [],
    ids: string[] = [],
    bytes = 0;
  try {
    const first = await approved.next();
    if (first.done || JSON.stringify(JSON.parse(first.value)) !== JSON.stringify(input.header))
      fail("Accepted header changed");
    for await (const page of input.source.pages()) {
      const next = await approved.next();
      if (next.done) fail("Missing accepted page");
      const expected = historyObject(JSON.parse(next.value));
      const request = {
        source: files.source,
        format: "cpamp-v1-jsonl",
        data: page,
        offset: 0,
        ...(input.mapRaw === undefined ? {} : { accountMappings: input.accountMappings }),
      };
      if (
        expected.page !== pages ||
        expected.input !== hash(JSON.stringify(request)) ||
        !Array.isArray(expected.ids) ||
        expected.ids.length > 200 ||
        expected.ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      )
        fail("Original page hash or ID manifest changed");
      const parsed = await parseBulkUsageImport(request, {
        pool: files.pool,
        person: files.caller,
      });
      const pageIds = parsed.records.map((row) => row.id);
      if (parsed.next !== null || JSON.stringify(pageIds) !== JSON.stringify(expected.ids))
        fail("Resolved IDs differ from the accepted manifest");
      for (const id of pageIds) retain.run(id);
      const pageBytes = Buffer.byteLength(page);
      if (
        ids.length &&
        (ids.length + pageIds.length > maximumBulkRows ||
          bytes + 1 + pageBytes > maximumBulkChunkBytes)
      ) {
        yield { data: data.join("\n"), ids };
        data = [];
        ids = [];
        bytes = 0;
      }
      bytes += pageBytes + (data.length ? 1 : 0);
      data.push(page);
      ids.push(...pageIds);
      pages++;
    }
    const end = await approved.next();
    if (
      end.done ||
      JSON.stringify(JSON.parse(end.value)) !== JSON.stringify({ complete: true, pages }) ||
      !(await approved.next()).done
    )
      fail("Incomplete or trailing accepted manifest");
    if (
      (await input.source.digest()) !== input.sourceHash ||
      (await fileDigest(files.acceptedManifest)) !== files.acceptedSha256 ||
      (files.accountMapFile !== undefined &&
        (await fileDigest(files.accountMapFile)) !== hash(input.mapRaw!))
    )
      fail("Frozen input changed during validation");
    if (ids.length) yield { data: data.join("\n"), ids };
  } finally {
    seen.close();
    await approved.return?.(undefined);
  }
}
export async function prepareBulk(raw: unknown): Promise<BulkDescriptor> {
  const files = filesInput(raw),
    input = await inputs(files);
  const chunks: BulkManifest["chunks"] = [];
  for await (const chunk of checkedChunks(files, input))
    chunks.push({
      sha256: hash(chunk.data),
      idsSha256: hash(JSON.stringify(chunk.ids)),
      rows: chunk.ids.length,
      bytes: Buffer.byteLength(chunk.data),
    });
  const manifest: BulkManifest = {
    version: 1,
    source: files.source,
    sourceHash: input.sourceHash,
    approvedManifestSha256: files.acceptedSha256,
    accountMappingDigest: hash(JSON.stringify(input.accountMappings)),
    totalRows: chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
    chunks,
  };
  const definition = await bulkDefinition(
    { manifest, accountMappings: input.accountMappings },
    {
      pool: files.pool,
      organization: files.organization,
      owner: files.caller,
    },
  );
  return { version: 1, files, definition };
}
export async function readDescriptor(path: string): Promise<BulkDescriptor> {
  const value = historyObject(await privateJson(path, 8 * 1024 * 1024));
  if (value.version !== 1) fail("Invalid descriptor version");
  const files = filesInput(value.files);
  const definition = await bulkDefinition(value.definition, {
    pool: files.pool,
    organization: files.organization,
    owner: files.caller,
  });
  if (JSON.stringify(definition) !== JSON.stringify(value.definition))
    fail("Descriptor is not canonical");
  return { version: 1, files, definition };
}
export async function verifyDescriptor(descriptor: BulkDescriptor) {
  const current = await prepareBulk(descriptor.files);
  if (JSON.stringify(current) !== JSON.stringify(descriptor)) fail("Descriptor input changed");
}
export function bulkStatus(raw: unknown, definition: BulkDefinition): BulkStatus {
  const value = historyObject(raw);
  if (
    value.job !== definition.job ||
    value.manifestDigest !== definition.manifestDigest ||
    value.accountMappingDigest !== definition.accountMappingDigest ||
    value.totalRows !== definition.manifest.totalRows ||
    value.totalChunks !== definition.manifest.chunks.length ||
    !["uploading", "running", "paused", "completed"].includes(String(value.state)) ||
    !["uploadedChunks", "committedChunks", "inserted", "existing"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isSafeInteger(value[key]) &&
        Number(value[key]) >= 0,
    ) ||
    Number(value.uploadedChunks) > Number(value.totalChunks) ||
    Number(value.committedChunks) > Number(value.uploadedChunks) ||
    Number(value.inserted) + Number(value.existing) > Number(value.totalRows) ||
    (value.state === "completed" &&
      (value.committedChunks !== value.totalChunks ||
        Number(value.inserted) + Number(value.existing) !== value.totalRows))
  )
    fail("Server did not acknowledge the exact manifest and account map");
  const reasons = [
    "operator_paused",
    "guard_paused",
    "chunk_unavailable",
    "chunk_invalid",
    "admission_failed",
    "commit_failed",
  ];
  if (value.reason !== null && !reasons.includes(String(value.reason)))
    fail("Unknown bulk pause reason");
  return {
    job: definition.job,
    state: String(value.state),
    manifestDigest: definition.manifestDigest,
    accountMappingDigest: definition.accountMappingDigest,
    totalRows: Number(value.totalRows),
    totalChunks: Number(value.totalChunks),
    uploadedChunks: Number(value.uploadedChunks),
    committedChunks: Number(value.committedChunks),
    inserted: Number(value.inserted),
    existing: Number(value.existing),
    reason: value.reason === null ? null : String(value.reason),
  };
}
/** No timestamp or CPU reading is refreshed locally; missing fields revoke readiness. */
export async function readGuard(path: string): Promise<BulkGuard> {
  const stopped: BulkGuard = {
    observedAt: 0,
    expiresAt: 0,
    ready: false,
    cpu: 0,
    poolErrors: 0,
    queryErrors: 0,
  };
  try {
    const value = historyObject(await privateJson(path, 16_384));
    for (const key of ["observedAt", "expiresAt", "poolErrors", "queryErrors"])
      if (
        typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 0
      )
        return stopped;
    if (
      typeof value.ready !== "boolean" ||
      typeof value.cpu !== "number" ||
      !Number.isFinite(value.cpu) ||
      value.cpu < 0
    )
      return stopped;
    const guard: BulkGuard = {
      observedAt: Number(value.observedAt),
      expiresAt: Number(value.expiresAt),
      ready: value.ready,
      cpu: value.cpu,
      poolErrors: Number(value.poolErrors),
      queryErrors: Number(value.queryErrors),
    };
    const now = Date.now();
    guard.ready =
      guard.ready &&
      guard.observedAt <= now &&
      guard.expiresAt > now &&
      guard.expiresAt - guard.observedAt <= 90_000 &&
      now - guard.observedAt <= 90_000 &&
      guard.cpu <= 100 &&
      guard.poolErrors === 0 &&
      guard.queryErrors === 0;
    return guard;
  } catch {
    return stopped;
  }
}
