import { createHash, randomUUID } from "node:crypto";

export function inventoryRecord(source: "pool-v1" | "pool-storage-v1", report: unknown, coverage: string[]) {
  const run = randomUUID();
  const json = JSON.stringify(report);
  if (Buffer.byteLength(json) > 120_000) throw new Error("Inventory limit exceeded");
  const chunks = Math.ceil(json.length / 8_000);
  for (let index = 0; index < chunks; index++) {
    console.info(JSON.stringify({ inventory: source, run, event: "part", index, data: json.slice(index * 8_000, (index + 1) * 8_000) }));
  }
  console.info(JSON.stringify({ inventory: source, run, event: "end", complete: true, chunks,
    bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(json).digest("hex"),
    coverage, migrationGo: false }));
}

export function inventoryFailure(source: "pool-v1" | "pool-storage-v1") {
  console.info(JSON.stringify({ inventory: source, run: randomUUID(), event: "end", complete: false, reason: "query_failed", migrationGo: false }));
}
