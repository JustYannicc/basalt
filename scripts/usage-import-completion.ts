import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { metadataLines, metadataInput, fileDigest } from "./usage-import-stream.ts";
import { counter, historyObject } from "../src/pool/model-history/record.ts";
import { importAccountMappings } from "../src/pool/model-history/import-account-mapping.ts";
import { parseUsageImport } from "../src/pool/model-history/import.ts";
import {
  completionHash,
  type ImportCompletionSelection,
} from "../src/pool/model-history/import-completion-contract.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export interface CompletionInput {
  file: string;
  manifest: string;
}

/** Verify frozen local exports, accepted page hashes and IDs before allowing a completion request. */
export async function completionManifestProof(
  inputs: CompletionInput[],
  identity: { pool: string; source: string },
) {
  if (!inputs.length) throw new Error("Completion needs its frozen source inputs");
  const db = new DatabaseSync("");
  db.exec("PRAGMA cache_size=-4096; CREATE TABLE ids(id TEXT PRIMARY KEY) WITHOUT ROWID; BEGIN");
  const retain = db.prepare("INSERT INTO ids(id) VALUES (?)");
  let rows = 0,
    upperSourceId = "0",
    frozenFrom = "",
    frozenTo = "",
    manifestDigest = "",
    accountMappingDigest = "";
  const manifestDigests: string[] = [];
  try {
    for (const input of inputs) {
      const source = await metadataInput(input.file),
        sourceHash = await source.digest();
      manifestDigest = await fileDigest(input.manifest);
      manifestDigests.push(manifestDigest);
      const iterator = metadataLines(input.manifest)[Symbol.asyncIterator]();
      let pages = 0;
      try {
        const first = await iterator.next();
        const header = historyObject(JSON.parse(first.value ?? "null"));
        if (
          header.version !== 1 ||
          header.source !== identity.source ||
          header.sourceHash !== sourceHash ||
          header.format !== "cpamp-v1-jsonl" ||
          typeof header.caller !== "string"
        )
          throw new Error("Accepted manifest source changed");
        const accountMappings = importAccountMappings(header.accountMappings);
        accountMappingDigest = sha(JSON.stringify(accountMappings));
        for await (const data of source.pages()) {
          const next = await iterator.next();
          if (next.done) throw new Error("Missing accepted page");
          const page = historyObject(JSON.parse(next.value));
          const request = {
            source: identity.source,
            format: "cpamp-v1-jsonl",
            data,
            offset: 0,
            ...(header.accountMappings === undefined ? {} : { accountMappings }),
          };
          if (
            page.page !== pages ||
            page.input !== sha(JSON.stringify(request)) ||
            !Array.isArray(page.ids) ||
            !page.ids.length ||
            page.ids.length > 200 ||
            page.ids.some((id) => !completionHash(id))
          )
            throw new Error("Accepted page or source changed");
          const parsed = await parseUsageImport(request, {
            pool: identity.pool,
            person: header.caller,
          });
          if (
            parsed.next !== null ||
            JSON.stringify(parsed.records.map((row) => row.id)) !== JSON.stringify(page.ids)
          )
            throw new Error("Source IDs differ from the accepted page");
          for (const row of parsed.records) {
            retain.run(row.id);
            rows++;
            if (!frozenFrom || row.timestamp < frozenFrom) frozenFrom = row.timestamp;
            if (!frozenTo || row.timestamp > frozenTo) frozenTo = row.timestamp;
          }
          for (const line of data.split(/\r?\n/).filter((line) => line.trim())) {
            const id = counter(historyObject(JSON.parse(line)).source_id);
            if (id === null || BigInt(id) <= BigInt(upperSourceId))
              throw new Error("Source ID order or range changed");
            upperSourceId = id;
          }
          pages++;
        }
        const end = await iterator.next();
        const footer = historyObject(JSON.parse(end.value ?? "null"));
        if (
          end.done ||
          footer.complete !== true ||
          footer.pages !== pages ||
          !(await iterator.next()).done ||
          (await source.digest()) !== sourceHash ||
          (await fileDigest(input.manifest)) !== manifestDigest
        )
          throw new Error("Frozen source or manifest changed");
      } finally {
        await iterator.return?.(undefined);
      }
    }
    db.exec("COMMIT");
    // Prefix groups match the database aggregate while keeping only one group's hash in memory.
    const buckets: string[] = [];
    let prefix = "",
      hash = createHash("sha256"),
      count = 0;
    for (const row of db.prepare("SELECT id FROM ids ORDER BY id").iterate()) {
      const id = String(row.id),
        next = id.slice(0, 2);
      if (next !== prefix) {
        if (count) buckets.push(`${prefix}:${hash.digest("hex")}`);
        prefix = next;
        hash = createHash("sha256");
        count = 0;
      }
      if (count++) hash.update("\n");
      hash.update(id);
    }
    if (count) buckets.push(`${prefix}:${hash.digest("hex")}`);
    return {
      frozenFrom,
      frozenTo,
      upperSourceId,
      verifiedRows: String(rows),
      manifestDigest,
      accountMappingDigest,
      idsDigest: sha(buckets.join("\n")),
      manifestDigests,
    };
  } finally {
    db.close();
  }
}
export async function verifyCompletionManifest(
  inputs: CompletionInput[],
  selection: ImportCompletionSelection,
) {
  const proof = await completionManifestProof(inputs, selection);
  for (const key of [
    "frozenFrom",
    "frozenTo",
    "upperSourceId",
    "verifiedRows",
    "manifestDigest",
    "accountMappingDigest",
    "idsDigest",
  ] as const)
    if (proof[key] !== selection[key])
      throw new Error(`Completion ${key} differs from the frozen source`);
  return proof;
}
