import { RuntimeProtection } from "../runtime-protection.ts";
import { PoolRuntimeUnhealthy } from "../lifecycle.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import { SlotRefused, executionKey, type SlotDriver, type SlotIdentity } from "./contract.ts";
import { healthy, type SlotClock } from "./proof.ts";
import { RuntimeSlotStorage } from "./storage.ts";
import { SlotStreams } from "./streams.ts";

interface RoutingDependencies {
  controllerId: string;
  driver: SlotDriver;
  storage: RuntimeSlotStorage;
  streams: SlotStreams;
  clock: SlotClock;
  defer(work: Promise<void>): void;
  wrap(response: Response, lease: NativeStreamLease): Response;
}

/** This is the only execution path. Slot drivers stay private to their controller. */
export class RuntimeSlotRouter {
  private protection = new Map<string, RuntimeProtection>();
  private deps: RoutingDependencies;
  constructor(deps: RoutingDependencies) {
    this.deps = deps;
  }

  async forward(
    pool: string,
    request: Request,
    port: 8317 | 8327,
    authorize: (signal: AbortSignal) => Promise<Request>,
  ): Promise<Response> {
    const pending = this.deps.streams.acquire(pool, request.signal);
    try {
      request = await authorize(pending.lease.signal);
      const identity = await this.deps.storage.transact(async ({ selection, policies }) => {
        const active = selection?.active;
        if (
          !active?.identity ||
          active.fenced ||
          active.retirement ||
          active.target.controllerId !== this.deps.controllerId
        )
          throw new SlotRefused("selection");
        const policy = policies.find((policy) => policy.pool === pool);
        if (!policy || policy.dirty) throw new SlotRefused("policy");
        // Only local lease metadata changes here. A retried transaction can safely rebind it.
        pending.bind(executionKey(active.identity));
        return active.identity;
      });
      const status = healthy(
        await this.deps.driver.health(
          identity,
          AbortSignal.any([pending.lease.signal, AbortSignal.timeout(2_000)]),
        ),
        identity,
        this.deps.clock,
      );
      this.guard(identity).admit({
        boot_id: identity.bootId,
        started_at: "slot",
        policyLeaseUntil: status.policyLeaseUntil,
      });
      pending.lease.signal.throwIfAborted();
      const upstream = await this.deps.driver.fetch(
        identity,
        new Request(request, { signal: pending.lease.signal }),
        port,
      );
      return this.deps.wrap(upstream, pending.lease);
    } catch (error) {
      pending.lease.release();
      throw error;
    }
  }

  private guard(identity: SlotIdentity) {
    const key = executionKey(identity);
    let guard = this.protection.get(key);
    if (guard) return guard;
    guard = new RuntimeProtection(this.deps.streams.forSlot(key), {
      check: async (signal) => {
        let health;
        try {
          health = healthy(
            await this.deps.driver.health(identity, signal),
            identity,
            this.deps.clock,
          );
        } catch (error) {
          if (error instanceof SlotRefused) throw new PoolRuntimeUnhealthy();
          throw error;
        }
        return {
          boot_id: identity.bootId,
          started_at: "slot",
          policyLeaseUntil: health.policyLeaseUntil,
        };
      },
      defer: (work) => this.deps.defer(work),
      unavailable: () => {},
      now: this.deps.clock.monotonic,
    });
    this.protection.set(key, guard);
    return guard;
  }
}
