import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseOutcome, ReleaseRequest, Wait } from "./rehearsal-plan.ts";

/** What the barrier left behind decides the outcome; a process exit alone proves nothing. */
export async function releaseOutcome(directory: string, exited: boolean): Promise<ReleaseOutcome> {
  const read = async (name: string) => {
    try {
      return JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const failure = await read("failure.json");
  if (failure) {
    if (typeof failure.reason !== "string" || !failure.reason)
      throw new Error("The release failed without a recorded refusal");
    return {
      ok: false,
      reason: failure.reason,
      ...(typeof failure.worker === "string" ? { worker: failure.worker } : {}),
    };
  }
  const receipt = await read("receipt.json");
  if (!exited || receipt?.phase !== "complete")
    throw new Error("The release ended without a complete receipt or a recorded refusal");
  return { ok: true };
}

export async function releaseWaits(directory: string): Promise<Wait[]> {
  let text: string;
  try {
    text = await readFile(join(directory, "rehearsal-waits.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const wait = JSON.parse(line) as Wait;
      if (
        typeof wait.name !== "string" ||
        typeof wait.outcome !== "string" ||
        !Number.isSafeInteger(wait.milliseconds)
      )
        throw new Error("Invalid rehearsal wait record");
      return wait;
    });
}

/**
 * The release environment a rehearsal hands to `scripts/deploy.ts`. A previous run's failure is
 * cleared first so each outcome belongs to its own attempt; receipts stay for resume.
 */
export async function releaseInput(
  root: string,
  request: ReleaseRequest,
  commit: string,
): Promise<NodeJS.ProcessEnv> {
  await rm(join(root, ".local", "release-barrier", "failure.json"), { force: true });
  return {
    BASALT_RELEASE_CANDIDATE: commit,
    // Production sets the availability target to its clean pool and leaves automatic recovery unset.
    POOL_AVAILABILITY_TARGET: request.cleanPool,
    BASALT_REHEARSAL_STOP: request.stop ?? "",
    BASALT_REHEARSAL_DRAIN_CAP_MS:
      request.drainCapMs === undefined ? "" : String(request.drainCapMs),
  };
}

/**
 * The previous release's snapshot at its stop. A release that failed after adopt leaves the legacy
 * root adopted at epoch 1 and unfenced; the next release has to start from exactly that.
 */
export async function adoptedSnapshot(directory: string): Promise<{ policies: unknown[] }> {
  const value = JSON.parse(await readFile(join(directory, "rehearsal-adopted.json"), "utf8")) as {
    selection?: { epoch?: unknown; active?: { target?: { slotId?: unknown }; fenced?: unknown } };
    policies?: unknown;
  };
  const selection = value.selection;
  if (
    selection?.epoch !== 1 ||
    selection.active?.target?.slotId !== "legacy" ||
    selection.active.fenced !== false
  )
    throw new Error("The previous release did not leave the legacy root adopted at epoch 1");
  if (!Array.isArray(value.policies)) throw new Error("The adopted snapshot has no policies");
  return { policies: value.policies };
}
