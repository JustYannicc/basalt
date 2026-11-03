import { accountAcquisitionPrefix } from "./account-acquisition-contract.ts";
import { signEnvelope } from "./token.ts";

export const observationPublishBudget = 30_000;
export const observationPublishPath = "/api/internal/account-observations/refresh";

/** The existing pool alarm publishes through the tools service's ordinary report writer. */
export async function publishAccountObservations(
  service: { fetch(input: string, init: RequestInit): Promise<Response> },
  signingKey: string,
  now = Date.now(),
): Promise<void> {
  const envelope = await signEnvelope(signingKey, accountAcquisitionPrefix, {
    action: "refresh-observations", at: now, expiresAt: now + 30_000,
  });
  const response = await service.fetch(`https://tools${observationPublishPath}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }), signal: AbortSignal.timeout(observationPublishBudget),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Account observation publication failed");
}
