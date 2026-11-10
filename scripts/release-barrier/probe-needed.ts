import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { probeNeeded } from "./probe-paths.ts";

const base = process.env.BASE_SHA ?? "";
const head = process.env.HEAD_SHA ?? "";
if (![base, head].every((value) => /^[a-f0-9]{40}$/.test(value)))
  throw new Error("Baseline probe selection requires immutable commits");
const changed = execFileSync("git", ["diff", "--name-only", "-z", `${base}...${head}`], {
  encoding: "utf8",
}).split("\0");
const needed = probeNeeded(changed);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
