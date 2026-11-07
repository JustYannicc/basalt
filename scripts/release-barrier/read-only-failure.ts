import { StateStoreError } from "alchemy/State/State";
import { ReadOnlyStateStoreVersionMismatch } from "alchemy/State/ReadOnlyHttpStateStore";
import { BarrierRefusal } from "./manifest.ts";

/** Preserve transport refusals even when a provider wraps them in its own error type. */
export function readOnlyFailure(error: unknown, network: readonly BarrierRefusal[]) {
  const first = network[0];
  if (first)
    return new BarrierRefusal(
      first.reason,
      first.worker,
      first.delta,
      network.flatMap((refusal) =>
        refusal.delta ? [{ reason: refusal.reason, ...refusal.delta }] : [],
      ),
    );
  if (error instanceof ReadOnlyStateStoreVersionMismatch)
    return new BarrierRefusal("read-only-state-version", "AlchemyStateStore", {
      fqn: "AlchemyStateStore",
      type: "Alchemy.State",
      changed: [{ path: "version", old: error.observed, new: error.expected }],
    });
  if (error instanceof StateStoreError)
    return new BarrierRefusal("read-only-state-access", "AlchemyStateStore", {
      fqn: "AlchemyStateStore",
      type: "Alchemy.State",
      changed: [{ path: "http.status", old: 200, new: error.http?.status ?? "unavailable" }],
    });
  return error;
}
