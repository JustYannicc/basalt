import { sameTarget, type SlotTarget } from "./contract.ts";
import { markStopSent } from "./container-end.ts";
import { stopGracefully } from "./forced-stop.ts";
import { forcedStopGraceMs } from "./forced-restart-timing.ts";
import type { RuntimeWitnessStore } from "./witness-store.ts";
import type { ControllerState } from "./runtime-state.ts";

type StopPath = "graceful_exit" | "destroy_after_grace" | "destroy_without_signal" | "stop_failed";

/**
 * Stops the container of a fleet cell's first start that never activated, once its controller has
 * fenced the slot. No call can reach that container, yet until it ends the provider lists it as
 * running, so it holds a fleet place up to its inactivity timeout and growth can't replace it.
 * The endpoint asks only behind the durable fence, inside its serialized section, so no queued
 * start or attestation can cross the stop. The stop is recorded before SIGTERM: a repeated pass,
 * a fresh controller or a replaced object never signals again, and one that finds the stop's own
 * run gone finishes it with `destroy()` once its grace has passed.
 */
export class RuntimeAbandonedStop {
  private ctx: ControllerState;
  private store: RuntimeWitnessStore;
  private role: "legacy" | "runtime";
  // One run per object, so a stop never repeats on every pass.
  private ran = false;
  constructor(ctx: ControllerState, store: RuntimeWitnessStore, role: "legacy" | "runtime") {
    this.ctx = ctx;
    this.store = store;
    this.role = role;
  }
  async stop(target: SlotTarget) {
    const container = this.ctx.container!;
    if (this.ran || !container.running) return;
    // The root's endpoint owns the root's own container, which this path never stops.
    if (this.role !== "runtime") return;
    const record = await this.store.retained(target.slotId);
    if (!record || !sameTarget(record.authorization.target, target)) return;
    // Only a fleet cell's first start; a primary's start or restart is never abandoned here.
    const { kind, target: started } = record.authorization;
    if (kind !== "initial-start" || started.homePeerOrdinal === undefined) return;
    // An attested start may already serve, so only its controller's failure path may end it.
    if (record.attestation) return;
    const sentAt = await this.store.stopSentAt(target.slotId);
    // A stop already sent is never sent again; inside its grace it is still under way.
    if (sentAt !== undefined && Date.now() - sentAt < forcedStopGraceMs) return;
    if (sentAt === undefined) await this.store.stopSent(target, Date.now());
    this.ran = true;
    await markStopSent(this.ctx);
    const graceful = typeof container.signal === "function";
    this.run(
      target,
      sentAt !== undefined
        ? async () => {
            await container.destroy();
            return "destroy_after_grace";
          }
        : async () =>
            (await stopGracefully(container)) === "exited"
              ? "graceful_exit"
              : graceful
                ? "destroy_after_grace"
                : "destroy_without_signal",
    );
  }
  private run(target: SlotTarget, stop: () => Promise<StopPath>) {
    const work = stop().then(
      (path) => path,
      (): StopPath => "stop_failed",
    );
    this.ctx.waitUntil(
      work.then((path) =>
        console.warn("POOL_RUNTIME_ABANDONED_STOP", {
          slot: target.slotId,
          ordinal: target.homePeerOrdinal ?? null,
          path,
        }),
      ),
    );
  }
}
