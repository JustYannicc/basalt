import { brand } from "../../brand.ts";
import { AcceptanceRefusal } from "./client.ts";

/**
 * The host comes from the target's name; a dispatch never names an address. Production is the
 * only target until a rehearsal stage has its own signing key and a modelled app host.
 */
export function targetOf(stage: string): { origin: string; signingKey: string | undefined } {
  if (stage === "production")
    return { origin: `https://${brand.host}`, signingKey: process.env.POOL_APP_SIGNING_KEY };
  throw new AcceptanceRefusal({
    format: "basalt-acceptance-pool-failure-v1",
    reason: "target_invalid",
    retryable: false,
  });
}
