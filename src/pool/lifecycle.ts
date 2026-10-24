export const poolLifecycle = {
  idleTimeoutMs: 2 * 60 * 60_000,
  refreshMs: 5 * 60_000,
  startupTimeoutMs: 180_000,
} as const;

export interface PoolStatus {
  boot_id: string;
  started_at: string;
}

export interface RuntimeDriver {
  running(): boolean;
  start(): void;
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

  private driver: RuntimeDriver;
  private storage: RuntimeStorage;
  private revision: string;
  private clock: { now(): number; sleep(ms: number): Promise<void> };

  constructor(
    driver: RuntimeDriver,
    storage: RuntimeStorage,
    revision: string,
    clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
  ) {
    this.driver = driver;
    this.storage = storage;
    this.revision = revision;
    this.clock = clock;
  }

  warm(): Promise<PoolStatus> {
    if (this.warming) return this.warming;
    this.warming = this.ensureWarm().finally(() => { this.warming = undefined; });
    return this.warming;
  }

  private async ensureWarm(): Promise<PoolStatus> {
    try {
      const previousRevision = await this.storage.get<string>("revision");
      if (this.driver.running() && previousRevision !== this.revision) await this.driver.stop();
      if (!this.driver.running()) this.driver.start();
      await this.driver.keepAlive(poolLifecycle.idleTimeoutMs);
      const deadline = this.clock.now() + poolLifecycle.startupTimeoutMs;
      while (this.clock.now() < deadline) {
        try {
          const status = await this.driver.status();
          if (!status.boot_id || !status.started_at) throw new Error("Missing pool runtime identity");
          await this.storage.put("revision", this.revision);
          return status;
        } catch {
          if (!this.driver.running()) throw new Error("The pool exited during startup");
          await this.clock.sleep(1_000);
        }
      }
      throw new Error("The pool did not become ready within the startup budget");
    } finally {
      // An alarm retries failed starts too. The container can outlive a sleeping DO.
      const next = this.clock.now() + poolLifecycle.refreshMs;
      const scheduled = await this.storage.getAlarm();
      if (scheduled === null || scheduled < this.clock.now() || scheduled > next) {
        await this.storage.setAlarm(next);
      }
    }
  }
}

export function poolPort(pathname: string): 8317 | 8327 | undefined {
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return 8317;
  if (unversionedModelPaths.has(pathname)) return 8317;
  if (/^\/v(?:0|8)\/management(?:\/|$)/.test(pathname)) return 8327;
  return undefined;
}

export function isPublicModelPath(pathname: string): boolean {
  return poolPort(pathname) === 8317;
}
