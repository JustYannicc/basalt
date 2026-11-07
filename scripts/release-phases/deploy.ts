import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { run } from "../process.ts";
import { checkReleaseHeadroom } from "./headroom.ts";

export const databasePhaseResources = ["PoolDatabase"];

export async function deployInPhases(options: {
  cloud: string;
  environment: NodeJS.ProcessEnv;
  sharedFoundation: boolean;
  preflight?: typeof checkReleaseHeadroom;
  execute?: typeof run;
  recovery?: string[];
}) {
  const recovery = options.recovery ?? [];
  if (recovery.length && (recovery.length !== 3 || recovery[0] !== "--recover"))
    throw new Error("Use --recover <manifest.json> <receipt.json>");
  const args = recovery.length ? ["--recover", resolve(recovery[1]!), resolve(recovery[2]!)] : [];
  if (options.sharedFoundation)
    throw new Error("Release barrier does not yet support the separate shared-domain stack");
  const headroom = await (options.preflight ?? checkReleaseHeadroom)(options.environment);
  console.log(
    `Database release admitted: primary total ${headroom.observed}, release envelope ${headroom.envelope}, ordinary slots ${headroom.ordinarySlots}.`,
  );
  const candidate =
    options.environment.BASALT_RELEASE_CANDIDATE ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: options.cloud, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(candidate))
    throw new Error("Release barrier requires an immutable candidate");
  (options.execute ?? run)(
    "bun",
    ["../../../../scripts/release-barrier/entry.ts", ...args],
    options.cloud,
    {
      ...options.environment,
      BASALT_RELEASE_CANDIDATE: candidate,
      BASALT_RELEASE_ATTEMPT: randomUUID(),
    },
  );
}
