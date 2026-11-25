/**
 * One scratch-stage operation: `deploy` (deploy, then read back what it made), `run` (deploy, then the
 * checks), or `destroy` (the stack's own destroy, then a delete of anything the stage still owns by
 * name, then a read-back that nothing is left). The workflow always follows deploy and run with
 * destroy, so nothing outlives the job.
 *
 * What it prints is public: pass or fail, counts and kinds. Never a name holding the account, a host
 * or an id, and a failure is published only through `publicFailure`.
 */
import { randomBytes } from "node:crypto";
import {
  counts,
  deployed,
  empty,
  inventory,
  removeAll,
  workersOrigin,
  type Account,
} from "./cloudflare.ts";
import type { Mode, Stage } from "./settings.ts";

export interface OperateDependencies {
  readonly account: Account;
  /** The release entry with this stage's stack; a failure carries no provider output. */
  readonly stack: (action: "deploy" | "destroy", stage: Stage, signingKey: string) => Promise<void>;
  readonly checks: (origin: string, signingKey: string) => Promise<Record<string, boolean>>;
  readonly log: (line: string) => void;
}

async function deploy(stage: Stage, signingKey: string, deps: OperateDependencies) {
  const before = await inventory(deps.account, stage);
  if (!empty(before)) throw new Error("The stage still holds resources; destroy it first");
  await deps.stack("deploy", stage, signingKey);
  const after = await inventory(deps.account, stage);
  deps.log(JSON.stringify({ deployed: counts(after) }));
  if (!deployed(after, stage)) throw new Error("The deployed stage is missing a named resource");
}

async function destroy(stage: Stage, deps: OperateDependencies) {
  // The stack's own state is local to this runner; a destroy in a later job finds none, so whatever
  // the stage still owns by name is deleted after it either way.
  await deps
    .stack("destroy", stage, randomBytes(32).toString("hex"))
    .catch(() => deps.log(JSON.stringify({ stackDestroy: "failed; deleting by name" })));
  const left = await inventory(deps.account, stage);
  const failed = empty(left) ? [] : await removeAll(deps.account, stage, left);
  const after = await inventory(deps.account, stage);
  deps.log(
    JSON.stringify({ leftBeforeDelete: counts(left), deleteFailures: failed, left: counts(after) }),
  );
  if (!empty(after)) throw new Error("Scratch resources remain after destroy");
}

/** Whether the operation passed. A refusal or a provider failure throws. */
export async function operate(stage: Stage, mode: Mode, deps: OperateDependencies) {
  if (mode === "destroy") {
    await destroy(stage, deps);
    return true;
  }
  // Made for this run only: it signs the run's envelopes, lives in the Worker's secret binding, and
  // is never written anywhere else.
  const signingKey = randomBytes(32).toString("hex");
  await deploy(stage, signingKey, deps);
  if (mode !== "run") return true;
  const results = await deps.checks(await workersOrigin(deps.account, stage), signingKey);
  const failed = Object.entries(results)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  deps.log(JSON.stringify({ checks: Object.keys(results).length, failed }));
  return failed.length === 0;
}

/**
 * A failure as the log may show it: its first line, with the account id, the token and anything
 * else secret cut out, whatever raised it (this code, the provider or the runtime).
 */
export function publicFailure(error: unknown, secrets: readonly (string | undefined)[]) {
  let text = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  for (const secret of secrets)
    if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  return JSON.stringify({ routeScratch: "failed", reason: text.slice(0, 200) });
}
