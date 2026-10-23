import { controlBasePath as base, type SignInFlow, type SignInStatus } from "../../apps/pool/contract.ts";
import { type ControlAttribution, type HomeDependencies, HomeClient, authorizeControl, handleControl, type Membership, PoolHome, type Session, signInTtlMs } from "./control.ts";
import { BackendFailure, fail, failureResponse, rows, text, unavailable } from "./json.ts";
import providers from "./providers.json" with { type: "json" };

export const attributionStorageKey = "pool-control-v1";
// Home's device waiters use 16 minutes; callback exchanges use 5 minutes.
const deviceWaitMs = 16 * 60_000;
const callbackDeadlineMs = 6 * 60_000;
const finalAnswerRetryMs = 5 * 60_000;
const pollPersistMs = 15_000;
const callbackWaitMs = 10_000;
// Home retains completed sessions for only one minute (oauth_sessions.go:16-17).
const statusCheckMs = 30_000;

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
interface TrackedSession { session: Session; result?: SignInStatus; pendingIds?: string[] }
interface PendingUpload { pool: string; id: string; upload: string; assigned?: boolean }
interface AttributionState {
  version?: 2;
  locks: Record<string, ProviderLock>;
  sessions: Record<string, TrackedSession>;
  /** Only ids whose membership write is in flight. Home groups own completed assignments. */
  assigned: string[];
  uploads?: Record<string, PendingUpload>;
}
interface LockSignal { released: Promise<void>; resolve: () => void }

/** The one control-plane DO serializes attribution for every pool. Views stay outside it. */
export class PoolControl implements ControlAttribution {
  private storage: ControlStorage;
  private deps: HomeDependencies;
  private client: HomeClient;
  private state!: AttributionState;
  private loaded = false;
  private dirty = false;
  private alarmDirty = false;
  private armedAlarm: number | null | undefined;
  private pollWritten = new Map<string, number>();
  private signals = new Map<string, LockSignal>();
  private released = new Set<string>();
  private blocked: Promise<void> | undefined;
  private added: (ids: string[]) => void = () => {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(storage: ControlStorage, deps: HomeDependencies) {
    this.storage = storage;
    this.deps = deps;
    this.client = new HomeClient(deps.home);
  }
  private now(): number { return this.deps.now?.().getTime() ?? Date.now(); }
  private changed(alarm = false): void { this.dirty = true; this.alarmDirty ||= alarm; }
  private async run<T>(work: () => Promise<T>): Promise<{ value: T; added: string[] }> {
    const result = this.queue.then(async () => {
      const added: string[] = [];
      this.added = (ids) => added.push(...ids);
      if (!this.loaded) {
        this.state = await this.storage.get<AttributionState>(attributionStorageKey) ?? { version: 2, locks: {}, sessions: {}, assigned: [] };
        await this.migrateAssignments();
        this.loaded = true;
        this.alarmDirty = Object.keys(this.state.locks).length > 0;
      }
      let value: T;
      try { value = await work(); }
      finally {
        await this.save();
        await this.arm();
        for (const provider of this.released) {
          this.signals.get(provider)?.resolve();
          this.signals.delete(provider);
        }
        this.released.clear();
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
        const providerIds = new Set(credentials.filter((row) => (text(row.provider) ?? text(row.type)) === provider).map((row) => text(row.id)));
        // Old assignments may protect a diff already in progress. Preserve that exclusion
        // in its snapshot before dropping historical markers with no pending write.
        lock.snapshot = [...new Set([...lock.snapshot, ...this.state.assigned])].filter((id) => providerIds.has(id));
      }
    }
    const pending = new Set(Object.values(this.state.sessions)
      .filter((tracked) => !tracked.result && Date.parse(tracked.session.expiresAt) > this.now())
      .flatMap((tracked) => tracked.pendingIds ?? []));
    this.state.assigned = this.state.assigned.filter((id) => pending.has(id));
    this.state.version = 2;
    this.changed();
    await this.save();
  }
  private async save(): Promise<void> {
    if (!this.dirty) return;
    await this.storage.put(attributionStorageKey, this.state);
    this.dirty = false;
    // A save for any reason also persists the latest in-memory device polling times.
    for (const [provider, lock] of Object.entries(this.state.locks)) this.pollWritten.set(provider, lock.lastPoll);
  }
  private async arm(): Promise<void> {
    if (!this.alarmDirty) return;
    const now = this.now();
    const deadlines = Object.values(this.state.locks).map((lock) => {
      const hard = lock.hardExpires ?? lock.expires + finalAnswerRetryMs;
      if (lock.cancelBlocked) return hard;
      const active = lock.flow === "device" || lock.flow === "callback";
      const next = active ? Math.min(lock.expires, lock.checkAt ?? lock.lastPoll + statusCheckMs) : lock.expires;
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
    this.pollWritten.delete(provider);
    this.released.add(provider);
    this.changed(true);
  }
  private async wait(released: Promise<void>, milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        released.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private collectQuota(ids: string[]): void {
    if (ids.length) {
      const work = this.client.refreshQuota(ids);
      this.deps.defer?.(work);
    }
  }
  async handle(request: Request): Promise<Response> {
    const deadline = Date.now() + callbackWaitMs;
    try {
      const { routeKey } = await authorizeControl(request, this.deps.signingKey, this.deps.previousSigningKey);
      if (routeKey === "GET /pool") return handleControl(request, { ...this.deps, client: this.client, attribution: null });
      const callback = routeKey === "POST /sign-ins/callback";
      for (;;) {
        const result = await this.run(async () => {
          this.blocked = undefined;
          const response = await handleControl(callback ? request.clone() : request, {
            ...this.deps, client: this.client, attribution: this, added: this.added,
          });
          return { response, released: this.blocked };
        });
        // Neither request nor alarm quota collection holds the attribution queue.
        this.collectQuota(result.added);
        if (!callback || !result.value.released || Date.now() >= deadline) return result.value.response;
        if (!await this.wait(result.value.released, deadline - Date.now())) return result.value.response;
      }
    } catch (error) { return failureResponse(error); }
  }
  async expire(): Promise<void> {
    const result = await this.run(async () => {
      this.armedAlarm = undefined;
      this.alarmDirty = true;
      await this.expireLocked(this.client);
    });
    this.collectQuota(result.added);
  }
  async expireLocked(client: HomeClient): Promise<void> {
    const now = this.now();
    for (const [provider, lock] of Object.entries(this.state.locks)) {
      const expired = lock.expires <= now;
      const hardExpired = (lock.hardExpires ?? lock.expires + finalAnswerRetryMs) <= now;
      const active = lock.flow === "device" || lock.flow === "callback";
      const checkDue = active && (lock.checkAt ?? lock.lastPoll + statusCheckMs) <= now;
      if (!hardExpired && (lock.cancelBlocked || (lock.retryAfter ?? 0) > now || (!expired && !checkDue))) continue;
      if (lock.state && !lock.cancelBlocked) {
        const tracked = this.state.sessions[lock.state];
        if (tracked) {
          const home = new PoolHome(client, tracked.session.pool, this.added);
          try {
            const result = await this.resolveStatus(home, tracked.session);
            if (result.status !== "waiting") continue;
            if (expired) {
              await this.cancel(home, tracked.session);
              if (tracked.result?.status === "failed") await this.finished(tracked.session, {
                status: "failed", message: "This sign-in timed out before it completed. Start again.",
              });
            } else { lock.checkAt = now + statusCheckMs; this.changed(true); }
            continue;
          } catch (error) {
            lock.cancelBlocked = error instanceof BackendFailure && (error.backendStatus === 401 || error.backendStatus === 403);
            // A missing final answer is not permission to reuse the provider's diff.
            if (!hardExpired) { lock.retryAfter = now + statusCheckMs; this.changed(true); continue; }
          }
        }
      }
      if (lock.state && this.state.sessions[lock.state]) {
        this.state.sessions[lock.state]!.result = { status: "failed", message: "This sign-in expired or could not be confirmed. Start again." };
      }
      this.unlock(provider);
    }
    for (const [state, tracked] of Object.entries(this.state.sessions)) {
      if (Date.parse(tracked.session.expiresAt) <= now && this.state.locks[tracked.session.provider]?.state !== state) {
        delete this.state.sessions[state]; this.changed();
      }
    }
  }
  private async resolveStatus(home: PoolHome, session: Session): Promise<SignInStatus> {
    // A previous ok already identified these ids. A retry only needs to finish membership,
    // even if Home's one-minute completed-session record has since disappeared.
    if (this.tracked(session).pendingIds?.length) return this.connected(home, session, []);
    const status = await home.status(session.state);
    if (status.status === "wait") return { status: "waiting" };
    if (status.status === "error") {
      const failed: SignInStatus = { status: "failed", message: "Sign-in failed or expired. Start again and approve access on the provider's page." };
      await this.finished(session, failed);
      return failed;
    }
    if (status.status !== "ok") return unavailable();
    const ids = Array.isArray(status.auth_ids) ? status.auth_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    if (text(status.auth_id)) ids.push(status.auth_id as string);
    return this.connected(home, session, ids);
  }
  async status(home: PoolHome, session: Session): Promise<SignInStatus> {
    const cached = this.cached(session);
    if (cached) return cached;
    await this.polled(session);
    return this.resolveStatus(home, session);
  }
  async cancel(home: PoolHome, session: Session): Promise<void> {
    if (this.cached(session)) return;
    if (await home.cancel(session.state)) await this.finished(session);
    else if ((await this.resolveStatus(home, session)).status === "waiting") return unavailable();
  }
  async rejectedCallback(session: Session): Promise<void> {
    this.tracked(session);
    const lock = this.state.locks[session.provider];
    if (lock?.state === session.state && lock.pool === session.pool && !lock.callbackResent) this.unlock(session.provider);
  }
  async acceptedCallback(session: Session): Promise<void> {
    const lock = this.state.locks[session.provider];
    if (lock?.state === session.state && lock.pool === session.pool) { lock.callbackRetry = false; this.changed(); }
  }
  private busy(provider: string): never {
    let signal = this.signals.get(provider);
    if (!signal) {
      let resolve!: () => void;
      const released = new Promise<void>((done) => { resolve = done; });
      signal = { released, resolve };
      this.signals.set(provider, signal);
    }
    this.blocked = signal.released;
    const name = providers.find((item) => item.id === provider)?.name ?? "provider";
    const minutes = Math.max(1, Math.ceil((this.state.locks[provider]!.expires - this.now()) / 60_000));
    return fail(409, "busy", `Someone is connecting a ${name} account right now. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, minutes * 60);
  }
  private async reserveLock(home: HomeClient, provider: string, pool: string, now: number): Promise<ProviderLock> {
    if (this.state.locks[provider]) return this.busy(provider);
    const snapshot = rows((await home.data("/credentials")).files)
      .filter((row) => (text(row.provider) ?? text(row.type)) === provider)
      .map((row) => text(row.id)).filter((id): id is string => id !== null);
    const lock: ProviderLock = { pool, state: null, snapshot, flow: "starting", expires: now + signInTtlMs, lastPoll: now };
    this.state.locks[provider] = lock;
    this.changed(true);
    return lock;
  }
  async reserve(home: HomeClient, provider: string, pool: string, now: Date): Promise<void> {
    const targetLock = this.state.locks[provider];
    if (targetLock && targetLock.pool !== pool) return this.busy(provider);
    // A pool keeps at most one session, including its readable completed result.
    // A start whose response was lost has no state to cancel safely.
    const unknown = Object.entries(this.state.locks).find(([, lock]) => lock.pool === pool && !lock.state);
    if (unknown) return this.busy(unknown[0]);
    for (const tracked of Object.values(this.state.sessions)) {
      if (tracked.session.pool !== pool) continue;
      await this.cancel(new PoolHome(home, pool, this.added), tracked.session);
      delete this.state.sessions[tracked.session.state];
      this.changed();
    }
    await this.reserveLock(home, provider, pool, now.getTime());
    await this.save(); // A device exchange may start in Home's next call.
  }
  async discard(provider: string): Promise<void> { this.unlock(provider); }
  async started(session: Session): Promise<void> {
    const lock = this.state.locks[session.provider];
    if (!lock || lock.pool !== session.pool) return unavailable();
    this.state.sessions[session.state] = { session };
    if (session.flow === "device") {
      lock.state = session.state;
      lock.flow = "device";
      lock.expires = this.now() + deviceWaitMs;
      lock.hardExpires = lock.expires + finalAnswerRetryMs;
      lock.checkAt = this.now() + statusCheckMs;
      this.changed(true);
    } else this.unlock(session.provider);
  }
  private tracked(session: Session): TrackedSession {
    const tracked = this.state.sessions[session.state];
    if (!tracked || tracked.session.pool !== session.pool || tracked.session.provider !== session.provider) {
      return fail(400, "invalid_session", "This sign-in no longer exists. Start again.");
    }
    return tracked;
  }
  cached(session: Session): SignInStatus | undefined { return this.tracked(session).result; }
  async callback(home: HomeClient, session: Session): Promise<boolean> {
    if (this.tracked(session).result) return fail(400, "invalid_session", "This sign-in has already finished.");
    const lock = this.state.locks[session.provider];
    if (lock?.state === session.state && lock.pool === session.pool) {
      if (lock.callbackRetry !== true) return false;
      const now = this.now();
      if (lock.expires <= now) return fail(400, "invalid_session", "This callback exchange has expired. Start again.");
      lock.callbackResent = true;
      lock.expires = now + callbackDeadlineMs;
      lock.hardExpires = lock.expires + finalAnswerRetryMs;
      lock.checkAt = now + statusCheckMs;
      lock.retryAfter = undefined;
      this.changed(true);
      await this.save();
      return true;
    }
    const reserved = await this.reserveLock(home, session.provider, session.pool, this.now());
    reserved.state = session.state;
    reserved.flow = "callback";
    reserved.checkAt = this.now() + statusCheckMs;
    reserved.expires = Math.min(Date.parse(session.expiresAt), this.now() + callbackDeadlineMs);
    reserved.hardExpires = reserved.expires + finalAnswerRetryMs;
    // Pessimistic until the POST is acknowledged, including eviction during the call.
    reserved.callbackRetry = true;
    await this.save(); // Bind the snapshot before Home accepts a callback.
    return true;
  }
  async polled(session: Session): Promise<void> {
    this.tracked(session);
    const lock = this.state.locks[session.provider];
    if (lock?.state === session.state && lock.pool === session.pool && (lock.flow === "device" || lock.flow === "callback")) {
      lock.lastPoll = this.now();
      if (lock.lastPoll - (this.pollWritten.get(session.provider) ?? 0) >= pollPersistMs) this.changed();
      this.alarmDirty = true;
    }
  }
  async finished(session: Session, result: SignInStatus = { status: "failed", message: "This sign-in has ended. Start again." }): Promise<void> {
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
  private async assigned(ids: string[]): Promise<void> {
    if (!ids.length) return;
    this.state.assigned = [...new Set([...this.state.assigned, ...ids])];
    this.changed();
    await this.save(); // Recover membership writes whose outcome is unknown after eviction.
  }
  async removed(id: string): Promise<void> {
    for (const [key, pending] of Object.entries(this.state.uploads ?? {})) {
      if (pending.id === id) { delete this.state.uploads![key]; this.changed(); }
    }
    for (const tracked of Object.values(this.state.sessions)) {
      if (!tracked.result && tracked.pendingIds?.includes(id)) {
        await this.finished(tracked.session, { status: "failed", message: "This account was removed while the sign-in was being completed. Start a new sign-in." });
      }
    }
    let failed = false;
    if (Object.keys(this.state.locks).length) {
      try {
        const credential = rows((await this.client.data("/credentials")).files).find((row) => row.id === id);
        const provider = credential && (text(credential.provider) ?? text(credential.type));
        if (credential && !provider) return unavailable();
        const lock = provider ? this.state.locks[provider] : undefined;
        // A detached credential may survive a failed delete. It must not become a
        // new candidate for a callback that predates its original upload.
        if (lock && !lock.snapshot.includes(id)) { lock.snapshot.push(id); this.changed(); }
      } catch {
        failed = true;
        for (const lock of Object.values(this.state.locks)) { lock.unconfirmedRemoval = true; this.changed(); }
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
  private async ownership(home: PoolHome): Promise<{ own: Membership; assigned: Set<string>; other: Set<string> }> {
    const all = await home.allMembership();
    const own = home.ownMembership(all);
    const ownGroups = new Set(own.groups.map((group) => group.id));
    return {
      own,
      assigned: new Set([...this.state.assigned, ...all.members.map((member) => member.auth_id)]),
      other: new Set(all.members.filter((member) => !ownGroups.has(member.channel_group_id)).map((member) => member.auth_id)),
    };
  }
  private conflicts(ids: string[], ownership: Awaited<ReturnType<PoolControl["ownership"]>>): boolean {
    const ownIds = new Set(ownership.own.members.map((member) => member.auth_id));
    return ids.some((id) => ownership.other.has(id) || (this.state.assigned.includes(id) && !ownIds.has(id)));
  }
  async retryUpload(home: PoolHome, key: string): Promise<string | undefined> {
    // Finish this pool's saved upload before allowing another one to create a credential.
    for (const [pendingKey, pending] of Object.entries(this.state.uploads ?? {})) {
      if (pending.pool !== home.pool) continue;
      await this.uploaded(home, pending.id, pending.upload, pendingKey);
      if (pendingKey === key) return pending.id;
    }
    return undefined;
  }
  async uploaded(home: PoolHome, id: string, upload: string, key: string): Promise<void> {
    const uploads = this.state.uploads ??= {};
    const pending = uploads[key] ??= { pool: home.pool, id, upload };
    this.changed();
    await this.save(); // Never repeat the credential POST after Home returned its id.
    const ownership = await this.ownership(home);
    const ownIds = new Set(ownership.own.members.map((member) => member.auth_id));
    if (ownership.other.has(id) || (!pending.assigned && this.state.assigned.includes(id) && !ownIds.has(id))) {
      delete uploads[key];
      this.changed();
      await this.uploadFinished(upload);
      return fail(400, "invalid_login_file", "This account is already assigned to another pool.");
    }
    pending.assigned = true;
    await this.assigned([id]);
    await this.uploadFinished(upload);
    await home.add([id], ownership.own);
    this.unassign([id]);
    delete uploads[key];
    this.changed();
  }
  async connected(home: PoolHome, session: Session, exactIds: string[]): Promise<SignInStatus> {
    const tracked = this.tracked(session);
    if (tracked.result) return tracked.result;
    const failWith = async (message: string): Promise<SignInStatus> => {
      const failed: SignInStatus = { status: "failed", message };
      await this.finished(session, failed);
      return failed;
    };
    let ids = tracked.pendingIds ?? [...new Set(exactIds)];
    const ownership = await this.ownership(home);
    if (ids.some((id) => ownership.other.has(id)) || (ids.length && !tracked.pendingIds && this.conflicts(ids, ownership))) {
      return failWith("An account returned by this sign-in is already assigned. No account was added.");
    }
    if (!ids.length) {
      const lock = this.state.locks[session.provider];
      if (!lock || lock.state !== session.state || lock.pool !== session.pool) return failWith("The account could not be safely identified. Start a new sign-in.");
      if (lock.unconfirmedRemoval) return failWith("An account removal could not be confirmed during this sign-in. No account was added. Start again.");
      if (lock.unconfirmedUploads?.length) return failWith("A login-file upload could not be confirmed during this sign-in. No account was added. Start again or upload the intended login file.");
      const before = new Set(lock.snapshot);
      ids = [...new Set((await home.credentials()).flatMap((row) => {
        const id = text(row.id);
        return id && !before.has(id) && !ownership.assigned.has(id) && (text(row.provider) ?? text(row.type)) === session.provider ? [id] : [];
      }))];
      if (ids.length === 0) return failWith("Sign-in completed, but no new account could be identified. No account was added. Start again or upload the login file.");
      if (ids.length > 1) return failWith("More than one new account appeared. No account was added. Upload the login file to connect the intended account.");
    }
    tracked.pendingIds = ids;
    this.changed();
    await this.assigned(ids);
    await home.add(ids, ownership.own);
    this.unassign(ids);
    const result: SignInStatus = { status: "connected", accountId: ids[0] ?? null };
    await this.finished(session, result);
    return result;
  }
}
