import { PoolAccountRemovals } from "./account-removals.ts";
import { type SignInFlow, type SignInStatus } from "../../apps/pool/contract.ts";
import {
  type ControlAttribution,
  type HomeDependencies,
  HomeClient,
  authorizeControl,
  handleControl,
  PoolHome,
  type Session,
} from "./control.ts";
import { fail, failureResponse, rows, text, unavailable } from "./json.ts";
import { QuotaCollection } from "./quota-collection.ts";
import { AccountActions } from "./account-actions.ts";
import { HomeAccountAcquisitions } from "./account-acquisition.ts";
import { nativeAccountHealth } from "./account-health.ts";
import { PoolViewSnapshots } from "./view-snapshot.ts";

export const attributionStorageKey = "pool-control-v1";
const statusCheckMs = 30_000;
const finalAnswerRetryMs = 5 * 60_000;

export interface ControlStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
interface ProviderLock {
  pool: string;
  state: string | null;
  snapshot: string[];
  flow: SignInFlow | "starting";
  expires: number;
  lastPoll: number;
  checkAt?: number;
  cancelBlocked?: boolean;
  retryAfter?: number;
  unconfirmedUploads?: string[];
  unconfirmedRemoval?: boolean;
  hardExpires?: number;
  callbackRetry?: boolean;
  callbackResent?: boolean;
}
interface TrackedSession {
  session: Session;
  accountId?: string;
  result?: SignInStatus;
  pendingIds?: string[];
}
interface PendingUpload {
  pool: string;
  id: string;
  upload: string;
  provider?: string;
  assigned?: boolean;
}
interface AttributionState {
  version?: 2;
  locks: Record<string, ProviderLock>;
  sessions: Record<string, TrackedSession>;
  /** Only ids whose membership write is in flight. Home groups own completed assignments. */
  assigned: string[];
  uploads?: Record<string, PendingUpload>;
  accountAcquisitions?: string[];
}

/** The one control-plane DO serializes attribution for every pool. Views stay outside it. */
export class PoolControl implements ControlAttribution {
  private views: PoolViewSnapshots;
  readonly collection: QuotaCollection;
  private actions: AccountActions;
  private removals: PoolAccountRemovals;
  private storage: ControlStorage;
  private deps: HomeDependencies;
  private client: HomeClient;
  private state!: AttributionState;
  private loaded = false;
  private dirty = false;
  private alarmDirty = false;
  private armedAlarm: number | null | undefined;
  private added: (ids: string[]) => void = () => {};
  private queue: Promise<unknown> = Promise.resolve();
  private acquisitions: HomeAccountAcquisitions;
  constructor(storage: ControlStorage, deps: HomeDependencies) {
    this.storage = storage;
    this.removals = new PoolAccountRemovals(storage);
    this.deps = deps;
    this.views = new PoolViewSnapshots(storage, (work) => deps.defer?.(work));
    this.client = new HomeClient(
      deps.home,
      () => this.now(),
      () => this.invalidateViews(),
    );
    this.acquisitions = new HomeAccountAcquisitions(
      storage,
      this.client,
      deps.signingKey,
      {
        begin: async () => {
          const marker = await this.uploadStarted();
          this.state.accountAcquisitions = [...(this.state.accountAcquisitions ?? []), marker];
          this.changed();
          await this.save();
          return marker;
        },
        removalAcknowledged: async ({ pool, references, actor, operation }) => {
          await this.removals.recordMany(pool, references, actor, new Date(this.now()), operation);
        },
        settle: async (marker, ids) => {
          if (ids.length) await this.invalidateViews();
          // A native account stays globally saved. An older legacy sign-in must never claim it.
          for (const lock of Object.values(this.state.locks)) {
            lock.snapshot = [...new Set([...lock.snapshot, ...ids])];
            this.changed();
          }
          await this.uploadFinished(marker);
          this.state.accountAcquisitions = (this.state.accountAcquisitions ?? []).filter(
            (id) => id !== marker,
          );
          this.changed();
          await this.save();
        },
      },
      deps.previousSigningKey,
      () => this.now(),
    );
    this.collection = new QuotaCollection(storage, this.client, { now: () => this.now() });
    this.actions = new AccountActions(this.client, storage, this.collection, () => this.now());
  }
  private now(): number {
    return this.deps.now?.().getTime() ?? Date.now();
  }
  async acquire(request: Request): Promise<Response> {
    const health = await nativeAccountHealth(request.clone(), {
      client: this.client,
      collection: this.collection,
      signingKey: this.deps.signingKey,
      previousSigningKey: this.deps.previousSigningKey,
      now: () => this.now(),
    });
    if (health !== undefined) return health;
    const result = await this.run(() => this.acquisitions.handle(request));
    await this.acquisitions.keepAlive();
    return result.value;
  }
  private changed(alarm = false): void {
    this.dirty = true;
    this.alarmDirty ||= alarm;
  }
  private async run<T>(work: () => Promise<T>): Promise<{ value: T; added: string[] }> {
    const result = this.queue.then(async () => {
      const added: string[] = [];
      this.added = (ids) => added.push(...ids);
      if (!this.loaded) {
        this.state = (await this.storage.get<AttributionState>(attributionStorageKey)) ?? {
          version: 2,
          locks: {},
          sessions: {},
          assigned: [],
        };
        await this.migrateAssignments();
        this.loaded = true;
        this.alarmDirty = Object.keys(this.state.locks).length > 0;
      }
      let value: T;
      try {
        value = await work();
      } finally {
        await this.save();
        await this.arm();
      }
      return { value, added };
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async migrateAssignments(): Promise<void> {
    if (this.state.version === 2) return;
    if (Object.keys(this.state.locks).length) {
      const credentials = rows((await this.client.data("/credentials")).files);
      for (const [provider, lock] of Object.entries(this.state.locks)) {
        const providerIds = new Set(
          credentials
            .filter((row) => (text(row.provider) ?? text(row.type)) === provider)
            .map((row) => text(row.id)),
        );
        // Old assignments may protect a diff already in progress. Preserve that exclusion
        // in its snapshot before dropping historical markers with no pending write.
        lock.snapshot = [...new Set([...lock.snapshot, ...this.state.assigned])].filter((id) =>
          providerIds.has(id),
        );
      }
    }
    const pending = new Set(
      Object.values(this.state.sessions)
        .filter((tracked) => !tracked.result && Date.parse(tracked.session.expiresAt) > this.now())
        .flatMap((tracked) => tracked.pendingIds ?? []),
    );
    this.state.assigned = this.state.assigned.filter((id) => pending.has(id));
    this.state.version = 2;
    this.changed();
    await this.save();
  }
  private async save(): Promise<void> {
    if (!this.dirty) return;
    await this.storage.put(attributionStorageKey, this.state);
    this.dirty = false;
  }
  private async arm(): Promise<void> {
    if (!this.alarmDirty) return;
    const now = this.now();
    const deadlines = Object.values(this.state.locks).map((lock) => {
      const hard = lock.hardExpires ?? lock.expires + finalAnswerRetryMs;
      if (lock.cancelBlocked) return hard;
      const active = lock.flow === "device" || lock.flow === "callback";
      const next = active
        ? Math.min(lock.expires, lock.checkAt ?? lock.lastPoll + statusCheckMs)
        : lock.expires;
      return Math.min(hard, Math.max(next, lock.retryAfter ?? 0));
    });
    if (deadlines.length) {
      const deadline = Math.max(now + 1_000, Math.min(...deadlines));
      this.armedAlarm ??= await this.storage.getAlarm();
      if (this.armedAlarm === null || this.armedAlarm <= now || deadline < this.armedAlarm) {
        await this.storage.setAlarm(deadline);
        this.armedAlarm = deadline;
      }
    }
    this.alarmDirty = false;
  }
  private unlock(provider: string): void {
    delete this.state.locks[provider];
    this.changed(true);
  }
  async handle(request: Request): Promise<Response> {
    try {
      const { isRead, isAccountAction } = await authorizeControl(
        request,
        this.deps.signingKey,
        this.deps.previousSigningKey,
      );
      if (isRead || isAccountAction)
        return handleControl(request, {
          ...this.deps,
          client: this.client,
          collection: this.collection,
          actions: this.actions,
          attribution: null,
          removals: (pool) => this.removals.read(pool),
          views: this.views,
        });
      const result = await this.run(() =>
        handleControl(request, {
          ...this.deps,
          client: this.client,
          attribution: this,
        }),
      );
      return result.value;
    } catch (error) {
      return failureResponse(error);
    }
  }
  async recordRemovalIntent(
    pool: string,
    references: readonly string[],
    actor: string,
    operation: string,
    issuedAt: number,
  ): Promise<boolean> {
    return (
      await this.run(() =>
        this.removals.recordMany(
          pool,
          references,
          actor,
          new Date(this.now()),
          operation,
          issuedAt,
        ),
      )
    ).value;
  }
  async invalidateViews(pool?: string): Promise<void> {
    this.client.invalidateGroups();
    await this.views.invalidate(pool);
  }
  async expire(): Promise<void> {
    await this.run(async () => {
      this.armedAlarm = undefined;
      this.alarmDirty = true;
      await this.expireLocked(this.client);
      await this.acquisitions.tick();
    });
    await this.acquisitions.keepAlive();
  }
  async expireLocked(client: HomeClient): Promise<void> {
    const now = this.now();
    // Retired pool sign-ins may outlive the release in durable storage. Their cleanup must
    // never poll a successful status into a new pool membership, including after eviction.
    for (const [provider, lock] of Object.entries(this.state.locks)) {
      if (lock.state) {
        try {
          await new PoolHome(client, lock.pool).cancel(lock.state);
        } catch {
          lock.retryAfter = now + statusCheckMs;
          lock.checkAt = lock.retryAfter;
          this.changed(true);
          continue;
        }
        const tracked = this.state.sessions[lock.state];
        if (tracked && !tracked.result) {
          tracked.result = {
            status: "failed",
            message: "Connect this account on its provider app.",
          };
          this.changed();
        }
      }
      this.unlock(provider);
    }
    for (const [state, tracked] of Object.entries(this.state.sessions)) {
      if (
        Date.parse(tracked.session.expiresAt) <= now &&
        this.state.locks[tracked.session.provider]?.state !== state
      ) {
        delete this.state.sessions[state];
        this.changed();
      }
    }
  }
  async cancel(home: PoolHome, session: Session): Promise<void> {
    if (this.cached(session)) return;
    // A provider may already have completed. Cancellation never claims its credential or
    // retries a pending legacy membership write when Home says it cannot cancel anymore.
    await home.cancel(session.state);
    await this.finished(session, {
      status: "failed",
      message: "Sign-in cancelled. Connect accounts on provider apps.",
    });
  }
  private tracked(session: Session): TrackedSession {
    const tracked = this.state.sessions[session.state];
    if (
      !tracked ||
      tracked.session.pool !== session.pool ||
      tracked.session.provider !== session.provider
    ) {
      return fail(400, "invalid_session", "This sign-in no longer exists. Start again.");
    }
    return tracked;
  }
  cached(session: Session): SignInStatus | undefined {
    return this.tracked(session).result;
  }
  async finished(
    session: Session,
    result: SignInStatus = { status: "failed", message: "This sign-in has ended. Start again." },
  ): Promise<void> {
    this.tracked(session).result = result;
    this.changed();
    const lock = this.state.locks[session.provider];
    if (lock?.state === session.state && lock.pool === session.pool) this.unlock(session.provider);
  }
  async uploadStarted(): Promise<string> {
    const upload = crypto.randomUUID();
    for (const lock of Object.values(this.state.locks)) {
      lock.unconfirmedUploads = [...(lock.unconfirmedUploads ?? []), upload];
      this.changed();
    }
    await this.save(); // A lost upload response must invalidate any overlapping diff.
    return upload;
  }
  async uploadFinished(upload: string): Promise<void> {
    for (const lock of Object.values(this.state.locks)) {
      if (!lock.unconfirmedUploads?.includes(upload)) continue;
      lock.unconfirmedUploads = lock.unconfirmedUploads.filter((id) => id !== upload);
      this.changed();
    }
  }
  async removed(id: string, intent?: { pool: string; actor: string; at: Date }): Promise<void> {
    if (intent) await this.removals.record(intent.pool, id, intent.actor, intent.at);
    for (const [key, pending] of Object.entries(this.state.uploads ?? {})) {
      if (pending.id === id) {
        delete this.state.uploads![key];
        this.changed();
      }
    }
    for (const tracked of Object.values(this.state.sessions)) {
      if (!tracked.result && tracked.pendingIds?.includes(id)) {
        await this.finished(tracked.session, {
          status: "failed",
          message:
            "This account was removed while the sign-in was being completed. Start a new sign-in.",
        });
      }
    }
    let failed = false;
    if (Object.keys(this.state.locks).length) {
      try {
        const credential = rows((await this.client.data("/credentials")).files).find(
          (row) => row.id === id,
        );
        const provider = credential && (text(credential.provider) ?? text(credential.type));
        if (credential && !provider) return unavailable();
        const lock = provider ? this.state.locks[provider] : undefined;
        // A detached credential may survive a failed delete. It must not become a
        // new candidate for a callback that predates its original upload.
        if (lock && !lock.snapshot.includes(id)) {
          lock.snapshot.push(id);
          this.changed();
        }
      } catch {
        failed = true;
        for (const lock of Object.values(this.state.locks)) {
          lock.unconfirmedRemoval = true;
          this.changed();
        }
      }
    }
    this.unassign([id]);
    await this.save(); // The credential is gone; membership cleanup can be retried.
    if (failed) return unavailable();
  }
  private unassign(ids: string[]): void {
    const removed = new Set(ids);
    const remaining = this.state.assigned.filter((id) => !removed.has(id));
    if (remaining.length === this.state.assigned.length) return;
    this.state.assigned = remaining;
    this.changed();
  }
}
