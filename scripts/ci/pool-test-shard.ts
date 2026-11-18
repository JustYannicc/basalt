import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = "scripts/pool-tests";
// Files that read the compatibility images run in the shard that restores them; the rest in the other.
const readsCompatibilityImages = /POOL_TEST_(?:LEGACY|USAGE_PRIVACY|BASE)_IMAGE/;

export const poolTestShards = ["contracts", "compatibility"] as const;

export function poolTestFiles(root: string, shard: (typeof poolTestShards)[number]) {
  return readdirSync(join(root, directory))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => `${directory}/${file}`)
    .filter(
      (path) =>
        readsCompatibilityImages.test(readFileSync(join(root, path), "utf8")) ===
        (shard === "compatibility"),
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shard = poolTestShards.find((name) => name === process.argv[2]);
  if (!shard) throw new Error("Expected a pool test shard: " + poolTestShards.join(" or "));
  const files = poolTestFiles(fileURLToPath(new URL("../../", import.meta.url)), shard);
  if (!files.length) throw new Error("Pool test shard has no files: " + shard);
  process.stdout.write(files.join("\n") + "\n");
}
