import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { changedInputs } from "./affected.ts";

export function selectUnitTests(tests: readonly string[], inputs: readonly string[]) {
  const selected = new Set(
    tests.filter((file) => /^scripts\/ci(?:-prepare)?\.test\.ts$/.test(file)),
  );
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const command = JSON.parse(readFileSync("package.json", "utf8")).scripts.check as string;
  if (!command.startsWith("node --test ") || /[;&|'"`$<>\\]/.test(command))
    throw new Error("Owned unit suite must be a node --test file list");
  const args = command.slice("node ".length).split(/\s+/);
  const options = args.filter((arg) => arg.startsWith("--"));
  const patterns = args.filter((arg) => !arg.startsWith("--"));
  if (options.some((option) => !/^--[a-z][a-z-]*(?:=\S+)?$/.test(option)))
    throw new Error("Owned unit options must use --name=value syntax");
  const tests = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => existsSync(file) && patterns.some((pattern) => matchesGlob(file, pattern)));
  if (!tests.length) throw new Error("Owned unit suite contains no test files");
  // `--shard=2/3` runs the whole owned suite's second third, for a full suite split across jobs.
  const shard = process.argv.slice(2).find((arg) => arg.startsWith("--shard="));
  if (shard !== undefined) {
    const value = shard.slice("--shard=".length);
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
    if (!match || Number(match[1]) > Number(match[2]))
      throw new Error(`Expected a shard like --shard=2/3, got ${shard}`);
    console.log(`Owned unit suite, shard ${value} of ${tests.length} files`);
    execFileSync(process.execPath, [...options, `--test-shard=${value}`, ...tests], {
      stdio: "inherit",
    });
    process.exit(0);
  }
  let selected = tests;
  try {
    selected = selectUnitTests(
      tests,
      changedInputs(root, process.env.BASE_SHA ?? "", process.env.HEAD_SHA ?? "").inputs,
    );
  } catch {
    console.log("Changed unit inputs could not be resolved; running the whole owned unit suite.");
  }
  if (!selected.length) throw new Error("Fast lane selected no unit tests");
  console.log("Selected unit tests:\n" + selected.join("\n"));
  execFileSync(process.execPath, [...options, ...selected], { stdio: "inherit" });
}
