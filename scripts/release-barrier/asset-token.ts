import { BarrierRefusal, type FrozenWorker } from "./manifest.ts";

const refusal = (reason: string, worker: string, path: string, observed: string, why: string) =>
  new BarrierRefusal(reason, worker, {
    fqn: worker,
    type: "Cloudflare.Worker",
    changed: [{ path, old: null, new: observed }],
    why: [why],
  });

/**
 * Cloudflare redeems an asset completion token once and answers a second redeem with 400/100312.
 * Startup admission uploads one frozen Worker up to three times, so each attempt after the first
 * takes a token from a fresh asset upload session. A token counts as redeemed before its upload
 * is sent: an unconfirmed upload may still have consumed it.
 */
export function assetCompletionTokens(
  session: (worker: FrozenWorker) => (() => Promise<string>) | undefined,
) {
  const redeemed = new Map<string, Set<string>>();
  return async (worker: FrozenWorker): Promise<string | undefined> => {
    const frozen = worker.metadata.assets?.jwt;
    if (!frozen) return undefined;
    const used = redeemed.get(worker.id) ?? new Set<string>();
    redeemed.set(worker.id, used);
    let token = frozen;
    if (used.size) {
      const renew = session(worker);
      if (!renew)
        throw refusal(
          "asset-upload-session-unavailable",
          worker.id,
          "$upload.assetSession",
          "unavailable",
          "The provider exposed no fresh asset upload session. No upload was sent.",
        );
      token = await renew();
    }
    if (!token || used.has(token))
      throw refusal(
        "asset-completion-token-not-renewed",
        worker.id,
        "$upload.assetCompletionToken",
        token ? `already redeemed (${used.size} redeemed)` : "missing",
        "A fresh asset upload session did not return an unredeemed completion token. No upload was sent.",
      );
    used.add(token);
    return token;
  };
}
