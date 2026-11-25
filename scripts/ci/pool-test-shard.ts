import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShard, shardIds, type Shard } from "../catalog-compat/shard.ts";

const directory = "scripts/pool-tests";
// Files that read the compatibility images run in the shard that restores them; the rest in the other.
const readsCompatibilityImages = /POOL_TEST_(?:LEGACY|USAGE_PRIVACY|BASE)_IMAGE/;

export const poolTestShards = ["contracts", "compatibility"] as const;

/**
 * A shard's files, or one part of them: within a shard each file hashes to exactly one part, as
 * catalog-compat's packages do, so a file added or removed moves no other file to another part.
 */
export function poolTestFiles(
  root: string,
  shard: (typeof poolTestShards)[number],
  part: Shard = { shard: 1, shards: 1 },
) {
  const files = readdirSync(join(root, directory))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => `${directory}/${file}`)
    .filter(
      (path) =>
        readsCompatibilityImages.test(readFileSync(join(root, path), "utf8")) ===
        (shard === "compatibility"),
    );
  return shardIds(files, part);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shard = poolTestShards.find((name) => name === process.argv[2]);
  if (!shard) throw new Error("Expected a pool test shard: " + poolTestShards.join(" or "));
  const part = parseShard(process.argv[3] || undefined);
  const files = poolTestFiles(fileURLToPath(new URL("../../", import.meta.url)), shard, part);
  if (!files.length)
    throw new Error(`Pool test shard has no files: ${shard} ${process.argv[3] ?? ""}`);
  process.stdout.write(files.join("\n") + "\n");
}
