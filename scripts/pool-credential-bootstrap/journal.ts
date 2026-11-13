import { open, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  BootstrapPacket,
  BootstrapRefusal,
  BootstrapTarget,
  canonical,
  decodePacket,
  decodeResult,
  digest,
  planDigest,
  secretName,
  targetDigest,
  validateApprovals,
  validatePlan,
  type BootstrapPlan,
} from "./contract.ts";
import { bootstrapProgram, programDigest } from "./program.ts";

const Owner = Schema.Struct({ target: BootstrapTarget, digest: Schema.String });
const Submission = Schema.Struct({
  packet: BootstrapPacket,
  planDigest: Schema.String,
  programDigest: Schema.String,
});
const decodeOwner = Schema.decodeUnknownSync(Owner, { onExcessProperty: "error" });
const decodeSubmission = Schema.decodeUnknownSync(Submission, { onExcessProperty: "error" });
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

function scopeDirectory(directory: string, plan: BootstrapPlan) {
  const { accountId, storeId } = plan.target;
  return join(
    directory,
    digest(canonical({ accountId, storeId, secretName: secretName(plan.target) })),
  );
}

async function durableCreate(path: string, value: unknown) {
  await writeFile(path, canonical(value) + "\n", { flag: "wx", mode: 0o600, flush: true });
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertOwner(directory: string, plan: BootstrapPlan) {
  const owner = decodeOwner(JSON.parse(await readFile(join(directory, "owner.json"), "utf8")));
  if (
    owner.digest !== targetDigest(plan.target) ||
    canonical(owner.target) !== canonical(plan.target)
  )
    throw new BootstrapRefusal("journal-target-drift");
}

async function originalCreate(directory: string, plan: BootstrapPlan) {
  let submission;
  try {
    submission = decodeSubmission(
      JSON.parse(await readFile(join(directory, "create.submission.json"), "utf8")),
    );
  } catch (error) {
    if (missing(error)) throw new BootstrapRefusal("original-create-submission-required");
    throw error;
  }
  const original = submission.packet.plan;
  if (
    original.mode !== "create" ||
    canonical(original.target) !== canonical(plan.target) ||
    submission.planDigest !== planDigest(original) ||
    submission.programDigest !== programDigest(original)
  )
    throw new BootstrapRefusal("original-create-submission-drift");
}

export const mcpInvocation = (plan: BootstrapPlan) => ({
  path: "tools.cloudflare.mcp.execute",
  input: {
    accountId: plan.target.connectionId,
    input: { account_id: plan.target.accountId, code: bootstrapProgram(plan) },
  },
});

export async function armBootstrap(directory: string, value: unknown, now = Date.now()) {
  const packet = decodePacket(value);
  const { plan } = packet;
  if (plan.mode === "inspect") throw new BootstrapRefusal("inspection-is-not-a-submission");
  validateApprovals(packet, programDigest(plan), now);
  const scope = scopeDirectory(directory, plan);
  if (plan.mode !== "create") await originalCreate(scope, plan);
  await mkdir(scope, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(directory));
  await syncDirectory(directory);
  try {
    await durableCreate(join(scope, "owner.json"), {
      target: plan.target,
      digest: targetDigest(plan.target),
    });
  } catch (error) {
    if (!exists(error)) throw error;
  }
  await assertOwner(scope, plan);
  if (plan.mode !== "create") {
    // A recovery cannot claim a token from a supplied ID alone. A retained inspection must name it.
    const inspections = (await readdir(scope)).filter((file) => file.endsWith(".inspection.json"));
    let owned = false;
    for (const file of inspections) {
      const result = decodeResult(JSON.parse(await readFile(join(scope, file), "utf8")));
      if (
        result.tokenId === plan.tokenId &&
        result.secretName === secretName(plan.target) &&
        result.outcome === "owned_token"
      )
        owned = true;
    }
    if (!owned) throw new BootstrapRefusal("owned-token-inspection-required");
  }
  const marker = join(
    scope,
    plan.mode === "create" ? "create.submission.json" : `${plan.attemptId}.submission.json`,
  );
  try {
    await durableCreate(marker, {
      packet,
      planDigest: planDigest(plan),
      programDigest: programDigest(plan),
    });
    // No invocation may escape before its directory entry survives a process or host failure.
    await syncDirectory(scope);
  } catch (error) {
    if (exists(error)) throw new BootstrapRefusal("submission-retained-inspect-only");
    throw error;
  }
  return mcpInvocation(plan);
}

export function inspectBootstrap(plan: BootstrapPlan, now = Date.now()) {
  validatePlan(plan, now);
  if (plan.mode !== "inspect") throw new BootstrapRefusal("inspection-plan-required");
  return mcpInvocation(plan);
}

export async function recordBootstrap(directory: string, plan: BootstrapPlan, value: unknown) {
  const result = decodeResult(value);
  if (plan.mode === "inspect" && result.outcome === "stored")
    throw new BootstrapRefusal("inspection-cannot-prove-custody");
  if (
    result.secretName !== secretName(plan.target) ||
    (plan.tokenId !== null && plan.tokenId !== result.tokenId)
  )
    throw new BootstrapRefusal("result-target-drift");
  const scope = scopeDirectory(directory, plan);
  await originalCreate(scope, plan);
  await assertOwner(scope, plan);
  if (plan.mode === "inspect") {
    await durableCreate(join(scope, `${plan.attemptId}.inspection.json`), result);
  } else {
    const marker = join(
      scope,
      plan.mode === "create" ? "create.submission.json" : `${plan.attemptId}.submission.json`,
    );
    let submission;
    try {
      submission = decodeSubmission(JSON.parse(await readFile(marker, "utf8")));
    } catch (error) {
      if (missing(error)) throw new BootstrapRefusal("submission-required");
      throw error;
    }
    if (
      submission.planDigest !== planDigest(plan) ||
      submission.programDigest !== programDigest(plan)
    )
      throw new BootstrapRefusal("submission-result-drift");
    await durableCreate(join(scope, `${plan.attemptId}.result.json`), result);
  }
  await syncDirectory(scope);
  return result;
}
