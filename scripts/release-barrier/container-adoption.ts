import type { RuntimeIdentity, RuntimeTarget } from "../../src/pool/deployment-readiness.ts";
import { bounded, type openDeploymentReadiness } from "../database-budget-readiness.ts";
import type { ServingClock } from "./serving-clock.ts";
import { retryableServingFailure, ServingFailure, servingFailure } from "./serving-failure.ts";

// Cloudflare defers active DO code updates for up to 300s by default. Keep 30s for transport.
// https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/
export const containerCodeAdoptionMs = 330_000;

/** Code adoption must finish before allocation or runtime startup spends its own budget. */
export async function waitForContainerCode(
  connection: Pick<Awaited<ReturnType<typeof openDeploymentReadiness>>, "adoption">,
  expected: RuntimeTarget,
  clock: ServingClock,
  end: number,
  signal: AbortSignal,
) {
  let observed: RuntimeIdentity | null = null;
  let last: ServingFailure | undefined;
  const identity = () => ({ expected, observed });
  while (clock.now() < end && !signal.aborted) {
    const attempt = clock.deadline(10_000);
    try {
      const requested = AbortSignal.any([signal, attempt.signal]);
      const result = await bounded(connection.adoption(requested), requested);
      observed = result.observed;
      if (result.adopted && clock.now() < end && !signal.aborted) return observed;
    } catch (error) {
      last = servingFailure("code-adoption", error);
      last.serving.codeIdentity = identity();
      if (!retryableServingFailure(last)) throw last;
    } finally {
      attempt.dispose();
    }
    try {
      await bounded(clock.sleep(Math.min(5_000, Math.max(0, end - clock.now()))), signal);
    } catch {
      break;
    }
  }
  throw new ServingFailure({
    check: "code-adoption",
    cause: "identity-deadline",
    ...(last?.serving.status === undefined ? {} : { status: last.serving.status }),
    codeIdentity: identity(),
  });
}
