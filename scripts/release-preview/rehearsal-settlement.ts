/**
 * A release stopped after adopt leaves its candidate's journal incomplete, so the next release
 * refuses until that candidate is settled. Production settles through the provisioning workflow's
 * plan, reviewed packet and apply; a rehearsal runs those same steps with its own GO.
 */
const commit = /^[a-f0-9]{40}$/u;
const goLifetimeMs = 30 * 60_000;
export const rehearsalGo = "release-rehearsal";

export function settlementPlanRequest(input: {
  previous: string;
  workerInput: string;
  number: number;
  now: number;
}) {
  if (!commit.test(input.previous) || !/^[a-f0-9]{64}$/u.test(input.workerInput))
    throw new Error("A settlement plan needs the previous candidate's exact controller code");
  return {
    kind: "release-settlement" as const,
    sourceCandidate: input.previous,
    operationId: `rehearsal-${input.number}-settlement`,
    coordinatorGo: rehearsalGo,
    expiresAt: input.now + goLifetimeMs,
    // The previous release adopted the legacy root under its own controller code, then stopped.
    disposition: "controller-active-adopted" as const,
    sourceController: { candidate: input.previous, workerInput: input.workerInput },
  };
}

/** The reviewed packet production's operator builds from a plan receipt, with the rehearsal's GO. */
export function settlementPacket(receipt: unknown, now: number) {
  const value = receipt as {
    disposition?: unknown;
    operation?: { kind?: unknown };
    operationDigest?: unknown;
  };
  if (
    value?.disposition !== "plan" ||
    value.operation?.kind !== "release-settlement" ||
    typeof value.operationDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.operationDigest)
  )
    throw new Error("The settlement plan wrote no release-settlement operation");
  return {
    operation: value.operation,
    go: {
      coordinatorGo: rehearsalGo,
      manifest: value.operationDigest,
      expiresAt: now + goLifetimeMs,
    },
  };
}

export function requireSettlementApplied(receipt: unknown, operationDigest: string) {
  const value = receipt as { disposition?: unknown; manifest?: unknown };
  if (value?.disposition !== "apply" || value.manifest !== operationDigest)
    throw new Error("The settlement apply did not record the planned operation");
}
