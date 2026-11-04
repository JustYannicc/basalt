import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fastPlan, runFastSteps } from "./fast-plan.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
let list = false,
  baseRef = "origin/main";
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--list") list = true;
  else if (args[index] === "--base" && args[index + 1] && !args[index + 1]!.startsWith("--"))
    baseRef = args[++index]!;
  else throw new Error("Usage: npm run ci:fast -- [--base <ref>] [--list]");
}
if (!list && !process.env.HEAVY_SLOT_ACTIVE) {
  const result = spawnSync(
    "heavy-slot",
    [process.execPath, fileURLToPath(import.meta.url), ...args],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, HEAVY_SLOTS: process.env.HEAVY_SLOTS || "6" },
    },
  );
  if (result.error)
    throw new Error(
      "ci:fast requires heavy-slot on PATH because preparation installs dependencies and builds assets. Install the shared slot wrapper before running the complete gate.",
    );
  process.exit(result.status ?? 1);
}
const git = (...arguments_: string[]) =>
  execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
const base = git("rev-parse", "--verify", `${baseRef}^{commit}`);
const head = git("rev-parse", "HEAD");
let parse: (source: string) => unknown;
try {
  ({ parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml"));
} catch {
  throw new Error(
    "Prepare this checkout first with heavy-slot npm run prepare:upstream, then run ci:fast again.",
  );
}
const plan = fastPlan(parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")), {
  root,
  base,
  head,
});
if (list) {
  console.log(JSON.stringify({ base, head, ...plan }, null, 2));
} else {
  if (git("status", "--porcelain", "--untracked-files=normal"))
    throw new Error(
      "Commit the candidate and keep the checkout clean before ci:fast; CI checks that exact commit.",
    );
  const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  if (process.versions.node !== plan.nodeVersion || bun !== plan.bunVersion)
    throw new Error(
      `CI fast requires Node ${plan.nodeVersion} and Bun ${plan.bunVersion}; found Node ${process.versions.node} and Bun ${bun}.`,
    );
  const directory = join(root, ".generated/ci-fast");
  mkdirSync(directory, { recursive: true });
  const evidence = mkdtempSync(join(directory, `${head.slice(0, 8)}-`));
  const startedAt = new Date().toISOString();
  for (const step of plan.skipped) console.log(`Skipped ${step.name}: ${step.reason}`);
  const result = runFastSteps(plan.steps, {
    ...process.env,
    CI: "true",
    RUNNER_TEMP: evidence,
    GITHUB_STEP_SUMMARY: join(evidence, "summary.md"),
    BASE_SHA: base,
    HEAD_SHA: head,
  });
  writeFileSync(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        base,
        head,
        lane: "fast-only",
        skipped: plan.skipped,
        startedAt,
        completedAt: new Date().toISOString(),
        ...result,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = result.status;
}
