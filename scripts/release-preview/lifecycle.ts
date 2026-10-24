import { requireSuccessfulSmoke } from "./receipt.ts";

export type PreviewHooks = {
  prepare(): Promise<void>;
  deploy(): Promise<void>;
  seed(): Promise<void>;
  smoke(): Promise<unknown>;
  destroy(): Promise<void>;
  verifyAbsent(): Promise<void>;
};

export type PreviewOutcome = { smoke: unknown; teardown: true };

/** Mark deployment attempted before calling it: a failed provision can still leave paid resources. */
export async function runPreview(hooks: PreviewHooks): Promise<PreviewOutcome> {
  let deploymentAttempted = false;
  let result: unknown;
  let failure: unknown;
  try {
    await hooks.prepare();
    deploymentAttempted = true;
    await hooks.deploy();
    await hooks.seed();
    result = await hooks.smoke();
    requireSuccessfulSmoke(result);
  } catch (error) { failure = error; }

  if (deploymentAttempted) {
    // Verify absence even when destroy fails. Do not let the smoke failure hide cleanup failure.
    const teardownFailures: unknown[] = [];
    try { await hooks.destroy(); } catch (error) { teardownFailures.push(error); }
    try { await hooks.verifyAbsent(); } catch (error) { teardownFailures.push(error); }
    if (teardownFailures.length) {
      throw new AggregateError([...(failure ? [failure] : []), ...teardownFailures],
        "Preview teardown failed; the stage must be recovered by the cleanup workflow");
    }
  }
  if (failure) throw failure;
  return { smoke: result, teardown: true };
}
