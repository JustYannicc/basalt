export const poolLifecycle = {
  idleTimeoutMs: 2 * 60 * 60_000,
  refreshMs: 5 * 60_000,
  startupTimeoutMs: 180_000,
} as const;

export interface PoolStatus {
  boot_id: string;
  started_at: string;
  policyLeaseUntil?: number;
  launch?: { generation: number; tokenHash: string };
}

/** A warm runtime lost readiness. The caller can retry after its protection recovers. */
export class PoolRuntimeUnhealthy extends Error {
  constructor() {
    super("The pool runtime is temporarily unhealthy");
  }
}

export class PoolStartupDeadline extends Error {
  constructor() {
    super("The pool did not become ready within the startup budget");
  }
}

export interface RuntimeDriver {
  running(): boolean;
  start(launch?: LaunchRecord): void;
  stop(): Promise<void>;
  keepAlive(milliseconds: number): Promise<void>;
  status(): Promise<PoolStatus>;
}

export interface RuntimeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
const unversionedModelPaths = new Set(["/messages", "/chat/completions", "/completions"]);

/** One controller owns startup, secret rotation, and the next recovery alarm. */
export class PoolLifecycle {
  private warming?: Promise<PoolStatus>;
  private served = false;

  private driver: RuntimeDriver;
  private storage: RuntimeStorage;
  private revision: string;
  private clock: { now(): number; sleep(ms: number): Promise<void> };
  private launch?: LaunchHooks;

  constructor(
    driver: RuntimeDriver,
    storage: RuntimeStorage,
    revision: string,
    clock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    launch?: LaunchHooks,
  ) {
    this.driver = driver;
    this.storage = storage;
    this.revision = revision;
    this.clock = clock;
    this.launch = launch;
  }

  warm(): Promise<PoolStatus> {
    if (this.warming) return this.warming;
    const work = this.ensureWarm().finally(() => {
      if (this.warming === work) this.warming = undefined;
    });
    this.warming = work;
    return this.warming;
  }

  async deploymentReady() {
    const status = await this.warm();
    if (
      (await this.storage.get<string>("revision")) !== this.revision ||
      (await this.storage.get<string>("ready-revision")) !== this.revision
    )
      throw new Error("Pool desired revision is not ready");
    return {
      bootId: status.boot_id,
      desiredRevisionMatch: true as const,
      readyAt: this.clock.now(),
    };
  }

  restart(beforeStop?: () => Promise<void>): Promise<PoolStatus> {
    const previous = this.warming;
    const restart = (async () => {
      // A pending warm must finish before destruction, or its retry loop could relaunch the old boot.
      await previous?.catch(() => {});
      await beforeStop?.();
      await this.driver.stop();
      this.served = false;
      return this.ensureWarm("restart");
    })();
    const work = restart.finally(() => {
      if (this.warming === work) this.warming = undefined;
    });
    this.warming = work;
    return this.warming;
  }

  startStopped(
    expected: LaunchExpectation,
    beforeStart: () => Promise<void>,
    afterReady: (status: PoolStatus) => Promise<void>,
    beforeLaunch?: () => Promise<void>,
  ): Promise<PoolStatus> {
    const previous = this.warming;
    const starting = (async () => {
      await previous?.catch(() => {});
      try {
        if (!this.launch) throw new LaunchRefused("launch-tracking-disabled");
        if (this.driver.running()) throw new LaunchRefused("runtime-no-longer-stopped");
        await beforeStart();
        await this.start(expected, beforeLaunch);
        const status = await this.awaitReady();
        await afterReady(status);
        return status;
      } finally {
        await this.schedule();
      }
    })();
    const work = starting.finally(() => {
      if (this.warming === work) this.warming = undefined;
    });
    this.warming = work;
    return work;
  }

  private async start(
    expected?: LaunchExpectation,
    beforeLaunch?: () => Promise<void>,
    intent?: "restart",
  ) {
    await this.storage.put("revision", this.revision);
    await this.storage.put("ready-revision", "");
    this.served = false;
    const launch = await this.launch?.prepare(expected, intent);
    await beforeLaunch?.();
    if (this.driver.running()) throw new LaunchRefused("runtime-no-longer-stopped");
    this.driver.start(launch);
  }

  private async awaitReady() {
    await this.driver.keepAlive(poolLifecycle.idleTimeoutMs);
    const deadline = this.clock.now() + poolLifecycle.startupTimeoutMs;
    while (this.clock.now() < deadline) {
      try {
        const status = await this.driver.status();
        if (!status.boot_id || !status.started_at) throw new Error("Missing pool runtime identity");
        await this.launch?.verify(status);
        this.served = true;
        await this.storage.put("ready-revision", this.revision);
        return status;
      } catch {
        if (!this.driver.running()) throw new Error("The pool exited during startup");
        if (this.served) throw new PoolRuntimeUnhealthy();
        await this.clock.sleep(1_000);
      }
    }
    throw new PoolStartupDeadline();
  }

  private async schedule() {
    const next = this.clock.now() + poolLifecycle.refreshMs;
    const scheduled = await this.storage.getAlarm();
    if (scheduled === null || scheduled > next) await this.storage.setAlarm(next);
  }

  private async ensureWarm(intent?: "restart"): Promise<PoolStatus> {
    try {
      const previousRevision = await this.storage.get<string>("revision");
      this.served =
        this.driver.running() &&
        previousRevision === this.revision &&
        (this.served || (await this.storage.get<string>("ready-revision")) === this.revision);
      if (this.driver.running() && previousRevision !== this.revision) await this.driver.stop();
      if (!this.driver.running()) {
        await this.start(undefined, undefined, intent);
      }
      return await this.awaitReady();
    } finally {
      // Membership upkeep shares this alarm and may already be due after a slow pass.
      await this.schedule();
    }
  }
}

export function poolPort(pathname: string): 8317 | 8327 | undefined {
  if (pathname === "/typesafe/v1/models" || pathname === "/typesafe/v1/systemone") return 8317;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return 8317;
  if (unversionedModelPaths.has(pathname)) return 8317;
  if (/^\/v(?:0|8)\/management(?:\/|$)/.test(pathname)) return 8327;
  return undefined;
}

export function isPublicModelPath(pathname: string): boolean {
  return poolPort(pathname) === 8317;
}
import {
  LaunchRefused,
  type LaunchExpectation,
  type LaunchHooks,
  type LaunchRecord,
} from "./launch-contract.ts";
