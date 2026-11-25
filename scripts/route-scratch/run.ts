/**
 * The workflow's entry for one scratch-stage operation (`operate.ts`). Applying and destroying go
 * only through the release entry, which never lets a deploy redeploy the shared State store (the
 * Alchemy CLI's `--yes` can), and its output stays out of the log. Every failure, whatever raised
 * it, is printed only through `publicFailure`.
 */
import { fileURLToPath } from "node:url";
import { captureChild } from "../failure/child.ts";
import { runChecks } from "./checks.ts";
import { operate, publicFailure } from "./operate.ts";
import { guard, type Stage } from "./settings.ts";

const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud", import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

async function stack(action: "deploy" | "destroy", stage: Stage, signingKey: string) {
  try {
    await captureChild(
      "bun",
      [
        "../../../../scripts/release/deploy.ts",
        action,
        "--stage",
        stage,
        "--config",
        "../../../../scripts/route-scratch/stack.ts",
      ],
      {
        cwd: cloud,
        env: { ...process.env, ALCHEMY_STAGE: stage, ROUTE_SCRATCH_SIGNING_KEY: signingKey },
        maximumOutputBytes: 24 * 1024 * 1024,
      },
    );
  } catch {
    // Provider failures can carry account details; only the step's name is published.
    throw new Error(`The scratch stack's ${action} failed; no provider output was published`);
  }
}

try {
  const { stage, mode } = guard(process.env, { credentialsLoaded: true });
  if (!accountId || !token) throw new Error("Missing Cloudflare credential");
  const passed = await operate(stage, mode, {
    account: { accountId, token },
    stack,
    checks: (origin, key) =>
      runChecks({ origin, key, idleMs: Number(process.env.ROUTE_SCRATCH_IDLE_MS ?? 600_000) }),
    log: (line) => console.log(line),
  });
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(publicFailure(error, [accountId, token]));
  process.exitCode = 1;
}
