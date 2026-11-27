import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShard, shardIds, type Shard } from "../catalog-compat/shard.ts";
import { importGraph, isCode, type ImportGraph } from "./import-graph.ts";

const directory = "scripts/pool-tests";
// Files that read the compatibility images run in the shard that restores them; the rest in the other.
const readsCompatibilityImages = /POOL_TEST_(?:LEGACY|USAGE_PRIVACY|BASE)_IMAGE/;
// A source that names the pool image or the docker CLI needs the image or a container runtime.
const needsImage = /POOL_TEST_IMAGE|\bdocker\b/i;

export const poolTestShards = ["contracts-image", "contracts-postgres", "compatibility"] as const;
/** Both contracts shards together, as a replay of the whole contracts suite asks for them. */
const contractsShard = "contracts" as const;
export type PoolTestShard = (typeof poolTestShards)[number];

/** Recorded seconds per file, refreshed by hand from a full Check; see the file's `refresh`. */
export const poolTestTimesFile = "scripts/ci/pool-test-times.json";

/** What each file loads, from the repository's own import graph: imports, paths and spawns. */
const loads = (graph: ImportGraph) => {
  const edges = new Map<string, string[]>();
  for (const [target, importers] of graph.importers)
    for (const importer of importers) edges.set(importer, [...(edges.get(importer) ?? []), target]);
  return edges;
};

/**
 * The chain by which a test file reaches the pool image, or undefined when it does not: the file
 * itself, or anything it loads, transitively, names the image or the docker CLI.
 */
export function imageChain(
  root: string,
  file: string,
  edges: ReadonlyMap<string, readonly string[]> = loads(importGraph(root)),
  seen = new Set<string>(),
): string[] | undefined {
  if (seen.has(file) || !isCode(file) || !existsSync(join(root, file))) return undefined;
  seen.add(file);
  if (needsImage.test(readFileSync(join(root, file), "utf8"))) return [file];
  for (const next of edges.get(file) ?? []) {
    const chain = imageChain(root, next, edges, seen);
    if (chain) return [file, ...chain];
  }
  return undefined;
}

const recordedSeconds = (root: string): Record<string, number> =>
  existsSync(join(root, poolTestTimesFile))
    ? JSON.parse(readFileSync(join(root, poolTestTimesFile), "utf8")).seconds
    : {};

/**
 * Split files into `shards` parts by recorded time: longest first, each onto the part with the
 * least time so far, then the fewest files, then the lowest number; files of equal time go by
 * name. A file with no recorded time counts the median recorded time. A stale time only makes a
 * part slower; every file still lands in exactly one part.
 */
export function partsByTime(
  files: readonly string[],
  seconds: Record<string, number>,
  shards: number,
) {
  const recorded = files
    .map((file) => seconds[file])
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b);
  const fallback = recorded.length ? recorded[Math.floor(recorded.length / 2)]! : 0;
  const cost = (file: string) => seconds[file] ?? fallback;
  const parts = Array.from({ length: shards }, () => ({ seconds: 0, files: [] as string[] }));
  // Code-point order, so every runner sorts alike whatever its locale.
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || byName(a, b))) {
    const part = parts.reduce((least, candidate) =>
      candidate.seconds < least.seconds ||
      (candidate.seconds === least.seconds && candidate.files.length < least.files.length)
        ? candidate
        : least,
    );
    part.files.push(file);
    part.seconds += cost(file);
  }
  return parts.map((part) => part.files.sort(byName));
}

/**
 * A shard's files, or one part of them.
 * - compatibility: the files that read the compatibility images, split by name hash.
 * - contracts-image: every other file that reaches the pool image, split by name hash.
 * - contracts-postgres: the rest, which need only PostgreSQL, split by recorded time.
 */
export function poolTestFiles(
  root: string,
  shard: PoolTestShard | typeof contractsShard,
  part: Shard = { shard: 1, shards: 1 },
) {
  const all = readdirSync(join(root, directory))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => `${directory}/${file}`);
  const compatibility = all.filter((path) =>
    readsCompatibilityImages.test(readFileSync(join(root, path), "utf8")),
  );
  if (shard === "compatibility") return shardIds(compatibility, part);
  const contracts = all.filter((path) => !compatibility.includes(path));
  if (shard === contractsShard) return shardIds(contracts, part);
  const edges = loads(importGraph(root));
  const image = contracts.filter((path) => imageChain(root, path, edges));
  if (shard === "contracts-image") return shardIds(image, part);
  const postgres = contracts.filter((path) => !image.includes(path));
  return partsByTime(postgres, recordedSeconds(root), part.shards)[part.shard - 1]!;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names: readonly (PoolTestShard | typeof contractsShard)[] = [
    ...poolTestShards,
    contractsShard,
  ];
  const shard = names.find((name) => name === process.argv[2]);
  if (!shard) throw new Error("Expected a pool test shard: " + names.join(", "));
  const part = parseShard(process.argv[3] || undefined);
  const files = poolTestFiles(fileURLToPath(new URL("../../", import.meta.url)), shard, part);
  if (!files.length)
    throw new Error(`Pool test shard has no files: ${shard} ${process.argv[3] ?? ""}`);
  process.stdout.write(files.join("\n") + "\n");
}
