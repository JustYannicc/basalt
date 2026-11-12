import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/** Real handle checks cover captured fixture processes without enumerating the shared host. */
export function fixtureInventory(
  t: TestContext,
  directory: string,
  options: { processTable?: boolean } = {},
) {
  const root = realpathSync(directory);
  const bin = join(root, "inventory-bin");
  const pids = join(root, "inventory-pids");
  const checkouts = join(root, "inventory-checkouts");
  const failure = join(root, "inventory-usage-failure");
  const repository = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const realLsof = execFileSync("which", ["lsof"], { encoding: "utf8" }).trim();
  const realPs = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
  mkdirSync(bin);
  writeFileSync(pids, "");
  writeFileSync(checkouts, "");
  writeFileSync(failure, "");
  const command = (name: string, source: string) => {
    const path = join(bin, name);
    writeFileSync(path, "#!/usr/bin/env node\n" + source);
    chmodSync(path, 0o755);
  };
  command(
    "git",
    `
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("list")) {
  if (args.length !== 6 || args[0] !== "-C" || args.slice(2).join(" ") !== "worktree list --porcelain -z")
    throw new Error("Unexpected fixture worktree inventory");
  const source = realpathSync(args[1]);
  if (source === ${JSON.stringify(repository)}) {
    const roots = readFileSync(${JSON.stringify(checkouts)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
    process.stdout.write(roots.map(root => "worktree " + root + "\\0\\0").join(""));
    process.exit(0);
  }
  if (!source.startsWith(${JSON.stringify(root + sep)}))
    throw new Error("Fixture inventory cannot observe another repository");
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
  );
  if (options.processTable)
    command(
      "ps",
      `
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "-axo" || args[0] === "-eo") {
  if (args.length !== 2 || args[1] !== "pid=,pgid=,stat=")
    throw new Error("Unexpected fixture process inventory");
  const recorded = readFileSync(${JSON.stringify(pids)}, "utf8").trim().split("\\n").filter(Boolean).map(Number);
  if (recorded.some(pid => !Number.isInteger(pid) || pid <= 0))
    throw new Error("Invalid fixture process identity");
  args.splice(0, args.length, "-p", [...new Set([process.ppid, ...recorded])].join(","), "-o", "pid=,pgid=,stat=");
}
const result = spawnSync(${JSON.stringify(realPs)}, args, { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
    );
  command(
    "lsof",
    `
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (process.argv.slice(2).join(" ") !== "-nP -F0n")
  throw new Error("Unexpected fixture handle inventory");
const failure = readFileSync(${JSON.stringify(failure)}, "utf8");
if (failure) {
  if (failure === "stderr") process.stderr.write("Fixture could not observe every open file\\n");
  process.exit(failure === "exit" ? 1 : 0);
}
const recorded = readFileSync(${JSON.stringify(pids)}, "utf8").trim().split("\\n").filter(Boolean).map(Number);
if (recorded.some(pid => !Number.isInteger(pid) || pid <= 0))
  throw new Error("Invalid fixture process identity");
const selected = [...new Set([process.ppid, ...recorded])];
const observed = spawnSync("ps", ["-p", selected.join(","), "-o", "pid=,stat="], { encoding: "utf8" });
if (observed.status !== 0 || observed.stderr.trim()) throw new Error("Cannot observe fixture processes");
const live = observed.stdout.trim().split("\\n").filter(Boolean).flatMap(line => {
  const [pid, state] = line.trim().split(/\\s+/);
  if (!Number.isInteger(Number(pid)) || !state) throw new Error("Invalid fixture process snapshot");
  return state.startsWith("Z") ? [] : [Number(pid)];
});
const result = spawnSync(${JSON.stringify(realLsof)}, ["-nP", "-a", "-p", live.join(","), "-F0n"], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  return {
    usageFailure(mode: "exit" | "stderr" | "") {
      writeFileSync(failure, mode);
    },
    track(pid: number) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Expected a captured fixture PID");
      appendFileSync(pids, `${pid}\n`);
    },
    checkout(path: string) {
      const actual = realpathSync(path);
      if (actual !== root && !actual.startsWith(root + sep))
        throw new Error("Fixture checkout must belong to its directory");
      appendFileSync(checkouts, JSON.stringify(actual) + "\n");
    },
  };
}
