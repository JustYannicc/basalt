import { brand } from "../../brand.ts";
import { isRehearsalStage } from "../release/rehearsal-stage.ts";
import { AcceptanceRefusal } from "./client.ts";

/**
 * The secret a rehearsal stage's own signing key is read from. No such secret exists yet: the
 * coordinator confirms its name with the stage tooling's owner before the first rehearsal.
 */
export const rehearsalSigningKeySecret = "REHEARSAL_POOL_APP_SIGNING_KEY";

/** The host is built from the stage rule; a dispatch never names an address. */
export function targetOf(stage: string): { origin: string; signingKey: string | undefined } {
  if (stage === "production")
    return { origin: `https://${brand.host}`, signingKey: process.env.POOL_APP_SIGNING_KEY };
  if (isRehearsalStage(stage))
    return {
      origin: `https://app.${stage.replace(/^test-/u, "")}.${brand.zone}`,
      signingKey: process.env[rehearsalSigningKeySecret],
    };
  throw new AcceptanceRefusal({
    format: "basalt-acceptance-pool-failure-v1",
    reason: "target_invalid",
    retryable: false,
  });
}
