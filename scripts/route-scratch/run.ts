/**
 * One scratch-stage operation: `deploy` (deploy, then read back what it made), `run` (deploy, then the
 * checks), or `destroy` (the stack's own destroy, then a delete of anything the stage still owns by
 * name, then a read-back that nothing is left). The workflow always follows deploy and run with
 * destroy, so nothing outlives the job.
 *
 * Applying and destroying go only through the release entry, which never lets a deploy redeploy the
 * shared State store (the Alchemy CLI's `--yes` can). Its output stays out of the log.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { captureChild } from "../failure/child.ts";
import { runChecks } from "./checks.ts";
import {
  counts,
  deployed,
  empty,
  inventory,
  removeAll,
  workersOrigin,
  type Account,
} from "./cloudflare.ts";
import { guard, type Stage } from "./settings.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cloud = `${root}.upstream/apps/hosted/cloud`;

function account(): Account {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("Missing Cloudflare credential");
  return { accountId, token };
}

/** The release entry, run from the cloud app as releases run it, with this stage's stack. */
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

async function deploy(stage: Stage, signingKey: string) {
  const before = await inventory(account(), stage);
  if (!empty(before)) throw new Error("The stage still holds resources; destroy it first");
  await stack("deploy", stage, signingKey);
  const after = await inventory(account(), stage);
  console.log(JSON.stringify({ deployed: counts(after) }));
  if (!deployed(after, stage)) throw new Error("The deployed stage is missing a named resource");
}

async function destroy(stage: Stage) {
  // The stack's own state is local to this runner; a destroy in a later job finds none, so whatever
  // the stage still owns by name is deleted after it either way.
  await stack("destroy", stage, randomBytes(32).toString("hex")).catch(() =>
    console.log(JSON.stringify({ stackDestroy: "failed; deleting by name" })),
  );
  const left = await inventory(account(), stage);
  const failed = empty(left) ? [] : await removeAll(account(), stage, left);
  const after = await inventory(account(), stage);
  console.log(
    JSON.stringify({ leftBeforeDelete: counts(left), deleteFailures: failed, left: counts(after) }),
  );
  if (!empty(after)) throw new Error("Scratch resources remain after destroy");
}

const { stage, mode } = guard(process.env, { credentialsLoaded: true });
if (mode === "destroy") await destroy(stage);
else {
  // Made for this run only: it signs the run's envelopes, lives in the Worker's secret binding, and
  // is never written anywhere else.
  const signingKey = randomBytes(32).toString("hex");
  await deploy(stage, signingKey);
  if (mode === "run") {
    const results = await runChecks({
      origin: await workersOrigin(account(), stage),
      key: signingKey,
      idleMs: Number(process.env.ROUTE_SCRATCH_IDLE_MS ?? 600_000),
    });
    const failed = Object.entries(results)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    console.log(JSON.stringify({ checks: Object.keys(results).length, failed }));
    if (failed.length) process.exitCode = 1;
  }
}
