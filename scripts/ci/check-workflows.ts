import { spawnSync } from "node:child_process";
import { ensureActionlint } from "./actionlint.ts";

const shellcheck = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
if (shellcheck.status !== 0)
  throw new Error(
    "ShellCheck is required for the same actionlint shell checks as CI. Install ShellCheck with your system package manager and make shellcheck available on PATH.",
  );

const version = "1.7.12";
const installed = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
if (installed.status === 0 && installed.stdout.split("\n")[0] === version) {
  const result = spawnSync("actionlint", ["-shellcheck", "shellcheck"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  const binary = ensureActionlint();
  const result = spawnSync(binary, ["-shellcheck", "shellcheck"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
