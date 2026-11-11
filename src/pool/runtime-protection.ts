import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";
import { NativeStreams } from "./native-streams.ts";
import { policyHealthProbeMs, policyHealthRefreshMs } from "./runtime-health.ts";

interface Pause {
  promise: Promise<void>;
  cancel(): void;
}
interface Dependencies {
  check(signal: AbortSignal): Promise<PoolStatus>;
  defer(work: Promise<void>): void;
  unavailable(count: number, diagnostic: ProtectionDiagnostic): void;
  now?: () => number;
  pause?: (milliseconds: number) => Pause;
}
export interface ProtectionDiagnostic {
  reason: "lease_expired" | "readiness_unhealthy" | "boot_changed";
  action: "preserved" | "closed";
  leaseRemainingMs: number;
  probeOutcome?: "healthy" | "unhealthy" | "timeout" | "transport";
  probeElapsedMs?: number;
}
const milliseconds = (value: number) =>
  Math.max(-86_400_000, Math.min(86_400_000, Math.round(value)));
function pause(milliseconds: number): Pause {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Readiness gates admission; a missed probe cannot invalidate work already dispatched. */
export class RuntimeProtection {
  private streams: Pick<NativeStreams, "active" | "abortAll">;
  private deps: Dependencies;
  private until = 0;
  private boot?: string;
  private watching?: Promise<void>;
  private degraded = false;
  private probe?: Pick<ProtectionDiagnostic, "probeOutcome" | "probeElapsedMs">;
  constructor(streams: Pick<NativeStreams, "active" | "abortAll">, deps: Dependencies) {
    this.streams = streams;
    this.deps = deps;
  }
  private now() {
    return this.deps.now?.() ?? performance.now();
  }
  private pause(milliseconds: number) {
    return (this.deps.pause ?? pause)(milliseconds);
  }

  admit(status: PoolStatus): void {
    if (this.degraded && this.watching && status.boot_id === this.boot)
      throw new PoolRuntimeUnhealthy();
    this.observe(status);
    this.start();
  }
  private observe(status: PoolStatus) {
    if (!Number.isFinite(status.policyLeaseUntil) || status.policyLeaseUntil! <= this.now())
      throw new PoolRuntimeUnhealthy();
    if (this.boot !== undefined && this.boot !== status.boot_id) this.fail("boot_changed", true);
    this.boot = status.boot_id;
    this.until = Math.max(this.until, status.policyLeaseUntil!);
    this.degraded = false;
  }
  private start() {
    if (this.watching || !this.streams.active) return;
    const work = this.watch();
    this.watching = work;
    this.deps.defer(
      work.finally(() => {
        if (this.watching === work) this.watching = undefined;
        if (this.streams.active) this.start();
      }),
    );
  }
  private fail(reason: ProtectionDiagnostic["reason"], close = false) {
    if (this.degraded && !close) return;
    const count = this.streams.active;
    const diagnostic: ProtectionDiagnostic = {
      reason,
      action: close ? "closed" : "preserved",
      leaseRemainingMs: milliseconds(this.until - this.now()),
      ...this.probe,
    };
    this.degraded = true;
    if (close) {
      this.streams.abortAll();
      this.until = 0;
    }
    if (count) this.deps.unavailable(count, diagnostic);
  }
  private async watch() {
    while (this.streams.active) {
      const remaining = this.until - this.now();
      if (remaining <= 0) this.fail("lease_expired");
      const interval = this.pause(
        remaining > 0 ? Math.min(policyHealthRefreshMs, remaining) : policyHealthRefreshMs,
      );
      await interval.promise;
      if (!this.streams.active) return;
      if (this.until <= this.now()) this.fail("lease_expired");
      const deadline = this.pause(policyHealthProbeMs);
      const abort = new AbortController();
      const started = this.now();
      try {
        const status = await Promise.race([
          this.deps.check(abort.signal),
          deadline.promise.then(() => undefined),
        ]);
        this.probe = {
          probeOutcome: status ? "healthy" : "timeout",
          probeElapsedMs: milliseconds(this.now() - started),
        };
        if (status) this.observe(status);
      } catch (error) {
        this.probe = {
          probeOutcome: error instanceof PoolRuntimeUnhealthy ? "unhealthy" : "transport",
          probeElapsedMs: milliseconds(this.now() - started),
        };
        if (error instanceof PoolRuntimeUnhealthy) {
          this.fail("readiness_unhealthy");
        }
      } finally {
        deadline.cancel();
        abort.abort();
      }
    }
  }
}
