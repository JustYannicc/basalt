import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";
import { NativeStreams } from "./native-streams.ts";
import { policyHealthProbeMs, policyHealthRefreshMs } from "./runtime-health.ts";

interface Pause { promise: Promise<void>; cancel(): void }
interface Dependencies {
  check(signal: AbortSignal): Promise<PoolStatus>;
  defer(work: Promise<void>): void;
  unavailable(count: number): void;
  now?: () => number;
  pause?: (milliseconds: number) => Pause;
}
function pause(milliseconds: number): Pause {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Upgraded sockets have no later ingress check. Their active leases must expire independently. */
export class RuntimeProtection {
  private streams: NativeStreams;
  private deps: Dependencies;
  private until = 0;
  private boot?: string;
  private watching?: Promise<void>;
  constructor(streams: NativeStreams, deps: Dependencies) { this.streams = streams; this.deps = deps; }
  private now() { return this.deps.now?.() ?? performance.now(); }
  private pause(milliseconds: number) { return (this.deps.pause ?? pause)(milliseconds); }

  admit(status: PoolStatus): void {
    if (!Number.isFinite(status.policyLeaseUntil) || status.policyLeaseUntil! <= this.now())
      throw new PoolRuntimeUnhealthy();
    if (this.boot !== undefined && this.boot !== status.boot_id) this.fail();
    this.boot = status.boot_id;
    this.until = Math.max(this.until, status.policyLeaseUntil!);
    this.start();
  }
  private start() {
    if (this.watching || !this.streams.active) return;
    const work = this.watch();
    this.watching = work;
    this.deps.defer(work.finally(() => {
      if (this.watching === work) this.watching = undefined;
      if (this.streams.active) this.start();
    }));
  }
  private fail() {
    const count = this.streams.active;
    this.streams.abortAll();
    this.until = 0;
    if (count) this.deps.unavailable(count);
  }
  private async watch() {
    while (this.streams.active) {
      const remaining = this.until - this.now();
      if (remaining <= 0) { this.fail(); return; }
      const interval = this.pause(Math.min(policyHealthRefreshMs, remaining));
      await interval.promise;
      if (!this.streams.active) return;
      if (this.until <= this.now()) { this.fail(); return; }
      const deadline = this.pause(Math.min(policyHealthProbeMs, this.until - this.now()));
      const abort = new AbortController();
      try {
        const status = await Promise.race([
          this.deps.check(abort.signal), deadline.promise.then(() => undefined),
        ]);
        if (status) this.admit(status);
      } catch (error) {
        if (error instanceof PoolRuntimeUnhealthy) { this.fail(); return; }
        // A missed read keeps only the already acknowledged lease, never a new grace period.
      } finally { deadline.cancel(); abort.abort(); }
    }
  }
}
