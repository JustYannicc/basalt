import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const base = process.env.BASE_SHA ?? "";
const head = process.env.HEAD_SHA ?? "";
if (![base, head].every((value) => /^[a-f0-9]{40}$/.test(value)))
  throw new Error("Baseline probe selection requires immutable commits");
const changed = execFileSync("git", ["diff", "--name-only", "-z", `${base}...${head}`], {
  encoding: "utf8",
}).split("\0");
const needed = changed.some((path) =>
  /^(?:scripts\/(?:release-barrier|release-phases)\/|patches\/|upstream\.json$|\.github\/workflows\/(?:ci|deploy|release-main|release-manual)\.yml$)/.test(
    path,
  ),
);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
