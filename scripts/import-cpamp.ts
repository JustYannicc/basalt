import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { metadataLines, metadataInput, fileDigest } from "./usage-import-stream.ts";
import { privateCredential, serviceOrigin } from "./usage-import-source.ts";
import { historyObject } from "../src/pool/model-history/record.ts";
import { importAccountMappings } from "../src/pool/model-history/import-account-mapping.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const { values } = parseArgs({
  options: {
    target: { type: "string" },
    "pool-token-file": { type: "string" },
    caller: { type: "string" },
    source: { type: "string" },
    file: { type: "string" },
    report: { type: "string" },
    "apply-report": { type: "string" },
    approve: { type: "string" },
    receipts: { type: "string" },
    "account-map-file": { type: "string" },
  },
});

// SQLite uses a temporary disk file, so checking millions of IDs stays memory-bounded.
const seenIds = new DatabaseSync("");
seenIds.exec("PRAGMA cache_size=-4096; CREATE TABLE ids(id TEXT PRIMARY KEY) WITHOUT ROWID");
const retainId = seenIds.prepare("INSERT INTO ids(id) VALUES (?)");

async function main() {
  if (
    !values.target ||
    !values["pool-token-file"] ||
    !values.caller ||
    !values.source ||
    !values.file
  )
    throw new Error("Missing import arguments");
  const target = serviceOrigin(values.target),
    applying = values["apply-report"] !== undefined;
  if (
    applying === (values.report !== undefined) ||
    (applying && (!values.approve || !values.receipts))
  )
    throw new Error("Choose dry-run report or approved apply-report with receipts");
  const token = await privateCredential(values["pool-token-file"]);
  const source = await metadataInput(values.file);
  const sourceHash = await source.digest();
  const mapFile = values["account-map-file"];
  if (mapFile) {
    const info = await stat(mapFile);
    if (!info.isFile() || info.size > 1_048_576 || (info.mode & 0o077) !== 0)
      throw new Error("Account map must be private and bounded");
  }
  const mapData = mapFile ? await readFile(mapFile, "utf8") : undefined;
  const accountMappings =
    mapData === undefined ? undefined : importAccountMappings(JSON.parse(mapData));
  const header = {
    version: 1,
    target: target.origin,
    caller: values.caller,
    source: values.source,
    sourceHash,
    format: "cpamp-v1-jsonl",
    ...(mapData === undefined ? {} : { accountMapHash: hash(mapData), accountMappings }),
  };
  const approved = applying
    ? metadataLines(values["apply-report"]!)[Symbol.asyncIterator]()
    : undefined;
  if (applying) {
    if ((await fileDigest(values["apply-report"]!)) !== values.approve)
      throw new Error("Approval digest mismatch");
    let count = -1,
      complete = false;
    for await (const line of metadataLines(values["apply-report"]!)) {
      const row = historyObject(JSON.parse(line));
      if (count === -1) {
        if (JSON.stringify(row) !== JSON.stringify(header))
          throw new Error("Approval header mismatch");
        count = 0;
      } else if (complete) throw new Error("Trailing approval data");
      else if (row.complete === true) {
        if (row.pages !== count) throw new Error("Approval page count mismatch");
        complete = true;
      } else {
        if (
          row.page !== count ||
          typeof row.input !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.input) ||
          !Array.isArray(row.ids) ||
          row.ids.length > 200 ||
          row.ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
        )
          throw new Error("Invalid approval page");
        for (const id of row.ids) retainId.run(String(id));
        count++;
      }
    }
    if (!complete) throw new Error("Incomplete approval manifest");
    const first = await approved!.next();
    if (first.done || JSON.stringify(JSON.parse(first.value)) !== JSON.stringify(header))
      throw new Error("Approval belongs to another source, owner or destination");
  }
  const output = await open(applying ? values.receipts! : values.report!, "wx", 0o600);
  async function append(value: unknown) {
    await output.writeFile(`${JSON.stringify(value)}\n`);
    await output.sync();
  }
  async function request(input: Record<string, unknown>) {
    const response = await globalThis.fetch(new URL("/pool/v1/usage/import", target), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-signalbox-caller": values.caller!,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Import refused");
    }
    const result = historyObject(await response.json());
    if (
      accountMappings !== undefined &&
      result.accountMappingDigest !== hash(JSON.stringify(accountMappings))
    )
      throw new Error("Server did not acknowledge the approved account map");
    return result;
  }
  let pages = 0,
    inserted = 0;
  try {
    await append(header);
    for await (const data of source.pages()) {
      const input = {
        source: values.source,
        format: "cpamp-v1-jsonl",
        data,
        offset: 0,
        ...(accountMappings === undefined ? {} : { accountMappings }),
      };
      const inputHash = hash(JSON.stringify(input));
      const next = applying ? await approved!.next() : undefined;
      const expected = next && !next.done ? historyObject(JSON.parse(next.value)) : undefined;
      if (applying && (expected?.input !== inputHash || expected?.page !== pages))
        throw new Error("Source page changed since approval");
      // Fresh short-lived approval for this exact page; the full manifest was approved separately.
      // A retry rechecks retained content, then inserts only missing IDs. Never retry uncertain HTTP here.
      const dry = await request({ ...input, mode: "dry-run" });
      if (
        dry.next !== null ||
        !Array.isArray(dry.ids) ||
        dry.ids.length > 200 ||
        dry.ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      )
        throw new Error("Invalid page result");
      if (applying && JSON.stringify(dry.ids) !== JSON.stringify(expected!.ids))
        throw new Error("Resolved IDs changed since approval");
      if (!applying) for (const id of dry.ids) retainId.run(String(id));
      const { approval, ...summary } = dry;
      const result = applying ? await request({ ...input, mode: "apply", approval }) : summary;
      if (
        applying &&
        (result.next !== null ||
          JSON.stringify(result.ids) !== JSON.stringify(dry.ids) ||
          typeof result.inserted !== "number" ||
          !Number.isSafeInteger(result.inserted) ||
          result.inserted < 0)
      )
        throw new Error("Invalid apply receipt");
      await append({
        page: pages,
        input: inputHash,
        ids: dry.ids,
        result: applying ? result : summary,
      });
      if (applying) inserted += Number(result.inserted);
      pages++;
    }
    if (applying) {
      const final = await approved!.next();
      if (
        final.done ||
        JSON.stringify(JSON.parse(final.value)) !== JSON.stringify({ complete: true, pages }) ||
        !(await approved!.next()).done
      )
        throw new Error("Incomplete approval manifest");
    }
    if ((await source.digest()) !== sourceHash)
      throw new Error("Source file changed during import");
    if (mapFile && (await fileDigest(mapFile)) !== hash(mapData!))
      throw new Error("Account map changed during import");
    await append({ complete: true, pages });
  } finally {
    await output.close();
    await approved?.return?.(undefined);
  }
  console.log(
    JSON.stringify({
      pages,
      inserted,
      writes: applying,
      sha256: await fileDigest(applying ? values.receipts! : values.report!),
    }),
  );
}

try {
  await main();
} catch {
  console.error(
    "Import stopped. No automatic retry. Reconcile retained IDs with the approved manifest before restarting with a new receipts path.",
  );
  process.exitCode = 1;
} finally {
  seenIds.close();
}
