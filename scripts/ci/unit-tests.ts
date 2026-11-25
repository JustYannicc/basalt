import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShard, shardIds } from "../catalog-compat/shard.ts";
import { changedInputs } from "./affected.ts";
import { dependents, trackedFiles } from "./import-graph.ts";
import { reach } from "./reach.ts";

/** `related` are tests that import or read an input, however far away: they run too. */
export function selectUnitTests(
  tests: readonly string[],
  inputs: readonly string[],
  related: Iterable<string> = [],
) {
  const selected = new Set(
    tests.filter((file) => /^scripts\/ci(?:-prepare)?\.test\.ts$/.test(file)),
  );
  for (const file of related) if (tests.includes(file)) selected.add(file);
  for (const input of inputs) {
    if (/^(?:docs\/|architecture\/|scripts\/architecture\/)|\.md$/.test(input)) continue;
    if (tests.includes(input)) {
      selected.add(input);
      continue;
    }
    const nearby = tests.filter((file) => dirname(file) === dirname(input));
    // Carries and inputs without colocated tests need the whole owned unit suite.
    if (!nearby.length || dirname(input) === ".") return [...tests];
    for (const file of nearby) selected.add(file);
  }
  return tests.filter((file) => selected.has(file));
}

/** The owned unit suite: `npm run check`'s node --test options and the tracked files it names. */
export function ownedUnitSuite(root: string) {
  const command = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).scripts.check as string;
  if (!command.startsWith("node --test ") || /[;&|'"`$<>\\]/.test(command))
    throw new Error("Owned unit suite must be a node --test file list");
  const args = command.slice("node ".length).split(/\s+/);
  const options = args.filter((arg) => arg.startsWith("--"));
  const patterns = args.filter((arg) => !arg.startsWith("--"));
  if (options.some((option) => !/^--[a-z][a-z-]*(?:=\S+)?$/.test(option)))
    throw new Error("Owned unit options must use --name=value syntax");
  const tests = trackedFiles(root).filter(
    (file) =>
      existsSync(`${root}/${file}`) && patterns.some((pattern) => matchesGlob(file, pattern)),
  );
  if (!tests.length) throw new Error("Owned unit suite contains no test files");
  return { options, tests };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const { options, tests } = ownedUnitSuite(root);
  // --all is the full lane's complete suite; otherwise the tests this change reaches.
  let selected = tests;
  if (!process.argv.includes("--all"))
    try {
      const { inputs } = changedInputs(
        root,
        process.env.BASE_SHA ?? "",
        process.env.HEAD_SHA ?? "",
      );
      // The affected lane runs no heavy job for a change only these tests reach, so they run here.
      selected = selectUnitTests(tests, inputs, dependents(reach(root).graph.importers, inputs));
    } catch {
      console.log("Changed unit inputs could not be resolved; running the whole owned unit suite.");
    }
  if (!selected.length) throw new Error("Fast lane selected no unit tests");
  const shard = parseShard(process.env.UNIT_SHARD || undefined);
  // Each file hashes to exactly one leg, as catalog-compat's packages do, so a file added or
  // removed moves no other file to another leg.
  const leg = shardIds(selected, shard);
  console.log(
    `Leg ${shard.shard}/${shard.shards}: ${leg.length} of ${selected.length} selected unit test files:\n` +
      leg.join("\n"),
  );
  // A focused selection can be smaller than the legs; the others then have nothing to run.
  if (leg.length) execFileSync(process.execPath, [...options, ...leg], { stdio: "inherit" });
}
