import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Deployment, Merge } from "../release-health.ts";

// The recorded history every guardrail test replays: GitHub's production deployments and merged
// pull requests of 5-18 Nov 2026, and this repository's own git history (CI checks out all of it).
export const root = fileURLToPath(new URL("../../..", import.meta.url));
export const git = (args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 }).trim();

const recorded = JSON.parse(
  readFileSync(new URL("../fixtures/production-2026-11.json", import.meta.url), "utf8"),
);
export const deployments: Deployment[] = recorded.deployments.map(
  ([sha, createdAt, committedAt, state]: [string, string, string, Deployment["state"]]) => ({
    sha,
    createdAt,
    committedAt,
    state,
  }),
);
export const merges: Merge[] = recorded.merges.map(([number, mergedAt]: [number, string]) => ({
  number,
  mergedAt,
}));

// The release path as it stood while that history was made; the recorded numbers were measured
// with it, so later edits to release-path.json leave them intact.
export const measured = [
  "alchemy.run.ts",
  "release-declarations.json",
  "patches/*alchemy*",
  "scripts/release-barrier/**",
  "scripts/release-phases/**",
  "scripts/release-merge/**",
  "scripts/deploy-safety/**",
  "scripts/deploy-main/**",
  "scripts/deploy.ts",
  ".github/workflows/deploy.yml",
  ".github/workflows/release-main.yml",
  ".github/workflows/release-manual.yml",
  ".github/workflows/release-rollback.yml",
  ".github/workflows/pool-runtime-provision.yml",
];
