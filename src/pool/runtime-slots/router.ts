import { refuseRuntime, type RuntimeRouteDiagnostic } from "../runtime-route-diagnostic.ts";
import { failedOn, placedOn } from "../runtime-placement.worker.ts";
import { modelLifetimeFetch } from "../model-lifetime.worker.ts";
import { RuntimeProtection } from "../runtime-protection.ts";
import { PoolRuntimeUnhealthy } from "../lifecycle.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import type { HomeDatabasePoolObservation } from "../home-database-pool.ts";
import {
  SlotRefused,
  awaitsProof,
  executionKey,
  sameIdentity,
  type SlotDriver,
  type SlotIdentity,
} from "./contract.ts";
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
  databasePool?(): HomeDatabasePoolObservation | null;
}

/** This is the only execution path. Slot drivers stay private to their controller. */
export class RuntimeSlotRouter {
  private protection = new Map<string, RuntimeProtection>();
  private deps: RoutingDependencies;
  constructor(deps: RoutingDependencies) {
    this.deps = deps;
  }

  async forward(
    pool: string | undefined,
    request: Request,
    port: 8317 | 8327,
    authorize: (signal: AbortSignal) => Promise<Request>,
    beforeDispatch: () => void = () => {},
    candidate?: SlotIdentity,
  ): Promise<Response> {
    const pending = this.deps.streams.acquire(pool ?? "", request.signal);
    let outbound: Request | undefined;
    let sent = false;
    let step: RuntimeRouteDiagnostic["runtimeStep"] = "slot_authorize";
    let placed: SlotIdentity | undefined;
    const runtime = candidate ? "candidate" : "root";
    try {
      request = await authorize(pending.lease.signal);
      step = "slot_selection";
      const identity = await this.deps.storage.transact(async ({ selection, policies }) => {
        const active = candidate ? selection?.candidate : selection?.active;
        if (
          !active?.identity ||
          active.fenced ||
          // A handed-back boot takes Home calls, the way current policies reach it, but no model
          // call until it is proven. The health read below still pins its boot on both ports.
          (port === 8317 && awaitsProof(active)) ||
          active.retirement ||
          active.target.controllerId !== this.deps.controllerId ||
          (candidate && !sameIdentity(active.identity, candidate))
        )
          throw new SlotRefused("selection");
        const policy = policies.find((policy) => policy.pool === pool);
        if (pool !== undefined && (!policy || policy.dirty)) throw new SlotRefused("policy");
        // Only local lease metadata changes here. A retried transaction can safely rebind it.
        pending.bind(executionKey(active.identity));
        return active.identity;
      });
      placed = identity;
      step = "slot_health";
      const status = healthy(
        await this.deps.driver.health(
          identity,
          AbortSignal.any([pending.lease.signal, AbortSignal.timeout(2_000)]),
        ),
        identity,
        this.deps.clock,
      );
      step = "slot_protection";
      this.guard(identity).admit({
        boot_id: identity.bootId,
        started_at: "slot",
        policyLeaseUntil: status.policyLeaseUntil,
      });
      step = "slot_pre_send";
      pending.lease.signal.throwIfAborted();
      outbound = new Request(request, { signal: pending.lease.signal });
      const beforeSend = () => {
        beforeDispatch();
        sent = true;
      };
      const forward = (request: Request) => this.deps.driver.fetch(identity, request, port);
      const dispatch = (request: Request) => {
        beforeSend();
        step = "slot_port";
        return forward(request);
      };
      const upstream =
        port === 8317
          ? await modelLifetimeFetch(outbound, forward, beforeSend)
          : await dispatch(outbound);
      const headers = new Headers(upstream.headers);
      headers.set("X-Signalbox-Pool-Boot", identity.bootId);
      const tagged =
        upstream.status === 101
          ? upstream
          : new Response(upstream.body, {
              status: upstream.status,
              statusText: upstream.statusText,
              headers,
            });
      return this.deps.wrap(placedOn(tagged, identity, runtime), pending.lease);
    } catch (error) {
      if (!sent) void outbound?.body?.cancel().catch(() => {});
      pending.lease.release();
      if (placed) failedOn(error, placed, runtime);
      refuseRuntime(step, error);
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
      unavailable: (count, diagnostic) => {
        console.error(
          diagnostic.action === "closed"
            ? "POOL_ACTIVE_STREAMS_CLOSED"
            : "POOL_RUNTIME_PROTECTION_UNAVAILABLE",
          {
            code: "pool_protection_unavailable",
            count,
            ...diagnostic,
            ...(this.deps.databasePool ? { homeDatabasePool: this.deps.databasePool() } : {}),
          },
        );
      },
      now: this.deps.clock.monotonic,
    });
    this.protection.set(key, guard);
    return guard;
  }
}
