import { poolGuard } from "./guard-failure.ts";
import { poolDependency } from "./dependency-failure.ts";
import { ControlFailure, object, text } from "./json.ts";
import { homeReferences } from "./home-references.ts";
import { openEnvelope } from "./token.ts";
import {
  membershipPrefix,
  membershipRefreshMs,
  membershipTtlMs,
  type NativeMembershipPolicy,
  type NativeMembershipSnapshot,
} from "./membership-contract.ts";

interface State extends NativeMembershipPolicy {
  native: boolean;
  checkedAt: number;
  installedRevision: number;
  installedUntil: number;
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
interface Dependencies {
  storage: Storage;
  signingKey: string;
  previousSigningKey?: string;
  read(pool: string, organization: string): Promise<NativeMembershipSnapshot>;
  actual(pool: string): Promise<readonly string[]>;
  reconcile(pool: string, accounts: readonly string[]): Promise<void>;
  install(policy: NativeMembershipPolicy): Promise<void>;
  abort(pool: string): void;
  invalidateView?(pool: string): Promise<void>;
  schedule(at: number): Promise<void>;
  now?: () => number;
}
const storageKey = "native-pool-memberships-v1";
const equal = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
const publicPolicy = ({
  pool,
  organization,
  revision,
  expiresAt,
  accounts,
  dirty,
}: State): NativeMembershipPolicy => ({ pool, organization, revision, expiresAt, accounts, dirty });

/** Durable desired state and periodic level repair. Backend membership never authorizes native use. */
export class NativeMemberships {
  private queue: Promise<unknown> = Promise.resolve();
  private running = new Map<string, Promise<void>>();
  private ticking?: Promise<void>;
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = {
      ...deps,
      read: (pool, organization) =>
        poolGuard("membership_read", () => deps.read(pool, organization)),
      reconcile: (pool, accounts) =>
        poolGuard("reconciliation", () => deps.reconcile(pool, accounts)),
      actual: (pool) => poolGuard("reconciliation", () => deps.actual(pool)),
      install: (policy) => poolGuard("native_policy_install", () => deps.install(policy)),
    };
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private run<A>(work: (state: Record<string, State>) => Promise<A>): Promise<A> {
    const next = this.queue.then(async () =>
      work(
        (await poolDependency(
          "storage",
          this.deps.storage.get<Record<string, State>>(storageKey),
        )) ?? {},
      ),
    );
    this.queue = next.catch(() => {});
    return next;
  }
  private save(state: Record<string, State>) {
    return poolDependency("storage", this.deps.storage.put(storageKey, state));
  }
  private async schedule() {
    await this.deps.schedule(this.now() + membershipRefreshMs);
  }

  async reserve(request: Request): Promise<void> {
    if (request.method !== "POST") throw new Error("Invalid native membership acknowledgement");
    const raw = await request.text();
    if (raw.length > 8_192) throw new Error("Invalid native membership acknowledgement");
    const input: unknown = JSON.parse(raw);
    const value =
      object(input) && typeof input.envelope === "string"
        ? await openEnvelope(
            this.deps.signingKey,
            membershipPrefix,
            input.envelope,
            this.deps.previousSigningKey,
          )
        : undefined;
    const now = this.now();
    if (
      !object(value) ||
      !text(value.pool) ||
      !text(value.organization) ||
      !Number.isSafeInteger(value.at) ||
      !Number.isSafeInteger(value.expiresAt) ||
      Number(value.at) > now ||
      Number(value.expiresAt) <= now ||
      Number(value.expiresAt) > now + 30_000
    )
      throw new Error("Invalid native membership acknowledgement");
    const pool = String(value.pool),
      organization = String(value.organization);
    await this.deps.invalidateView?.(pool);
    const policy = await this.run(async (state) => {
      const previous = state[pool];
      if (previous && previous.organization !== organization)
        throw new Error("Native pool organization changed");
      const next: State = {
        pool,
        organization,
        revision: (previous?.revision ?? 0) + 1,
        expiresAt: now + membershipTtlMs,
        accounts: previous?.accounts ?? [],
        dirty: true,
        native: true,
        checkedAt: previous?.checkedAt ?? 0,
        installedRevision: 0,
        installedUntil: 0,
      };
      state[pool] = next;
      await this.save(state);
      this.deps.abort(pool);
      return next;
    });
    await this.schedule();
    // The local veto refuses old selections before the SQL writer is allowed to commit.
    await this.deps.install(publicPolicy(policy));
  }

  async authority(pool: string): Promise<NativeMembershipPolicy | undefined> {
    return this.run(async (state) => {
      const policy = state[pool];
      if (!policy) return undefined;
      if (
        policy.dirty ||
        !policy.native ||
        policy.expiresAt <= this.now() ||
        policy.installedRevision !== policy.revision ||
        policy.installedUntil <= this.now()
      )
        throw new ControlFailure(
          503,
          "backend_unavailable",
          "Native pool membership is refreshing",
        );
      return publicPolicy(policy);
    });
  }
  async configured(): Promise<boolean> {
    return this.run(async (state) => Object.keys(state).length > 0);
  }
  async ensure(pool: string, organization: string): Promise<void> {
    let current = await this.run(async (state) => state[pool]);
    if (!current) {
      // The private reader may reserve this same object while completing the host's SQL handoff.
      // Never hold our queue across that callback.
      const snapshot = await this.deps.read(pool, organization);
      if (!snapshot.native) return;
      const created = await this.run(async (state) => {
        if (state[pool]) return undefined;
        const next: State = {
          pool,
          organization,
          revision: 1,
          expiresAt: this.now() + membershipTtlMs,
          accounts: [],
          dirty: true,
          native: true,
          checkedAt: 0,
          installedRevision: 0,
          installedUntil: 0,
        };
        state[pool] = next;
        await this.save(state);
        this.deps.abort(pool);
        return next;
      });
      if (created) {
        await this.schedule();
        await this.deps.install(publicPolicy(created));
      }
      current = await this.run(async (state) => state[pool]);
    }
    if (!current || current.organization !== organization)
      throw new Error("Native pool organization changed");
    if (
      current.dirty ||
      !current.native ||
      current.expiresAt <= this.now() ||
      current.installedRevision !== current.revision ||
      current.installedUntil <= this.now()
    )
      await this.refresh(pool);
    // A signed invalidation alone does not convert retained Home bindings to native authority.
    // The host's registration decides that handoff; native model use remains vetoed by authority().
    if (!(await this.run(async (state) => state[pool]?.native))) return;
    await this.authority(pool);
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const work = this.tickOnce().finally(() => {
      if (this.ticking === work) this.ticking = undefined;
    });
    this.ticking = work;
    return work;
  }
  private async tickOnce(): Promise<void> {
    const pools = await this.run(async (state) => Object.keys(state));
    if (!pools.length) return;
    await this.schedule();
    try {
      await Promise.allSettled(pools.map((pool) => this.refresh(pool)));
    } finally {
      // An alarm can consume the deadline while joining an HTTP-triggered repair.
      await this.schedule();
    }
  }
  refresh(pool: string): Promise<void> {
    const active = this.running.get(pool);
    if (active) return active;
    const task = this.repair(pool).finally(() => this.running.delete(pool));
    this.running.set(pool, task);
    return task;
  }
  private async repair(pool: string): Promise<void> {
    // Reservations can supersede either external read or installation while this repair is running.
    // Callers share this promise, so it must follow the newest revision before resolving.
    while (true) {
      const before = await this.run(async (state) => state[pool]);
      if (!before) return;
      const snapshot = await this.deps.read(pool, before.organization);
      const accounts = [
        ...new Set(
          snapshot.accounts.flatMap((account) =>
            account.homeReference === null ? [] : homeReferences(account.homeReference),
          ),
        ),
      ].sort();
      const valid =
        snapshot.native && snapshot.accounts.every((account) => account.homeReference !== null);
      // Each pass reads actual state, including a write that arrived after a previous matching read.
      if (valid) await this.deps.reconcile(pool, accounts);
      const actual = valid ? await this.deps.actual(pool) : [];
      const ready = valid && equal(actual, accounts);
      const policy = await this.run(async (state) => {
        const current = state[pool];
        if (!current || current.revision !== before.revision) return undefined;
        const changed = current.dirty !== !ready || !equal(current.accounts, accounts);
        const next: State = {
          ...current,
          native: snapshot.native,
          accounts,
          revision: current.revision + (changed ? 1 : 0),
          dirty: !ready,
          expiresAt: this.now() + membershipTtlMs,
          checkedAt: this.now(),
        };
        state[pool] = next;
        await this.save(state);
        return next;
      });
      if (!policy) continue;
      await this.deps.install(publicPolicy(policy));
      const installed = await this.run(async (state) => {
        const current = state[pool];
        if (!current || current.revision !== policy.revision) return false;
        state[pool] = {
          ...current,
          installedRevision: policy.revision,
          installedUntil: Math.max(current.installedUntil ?? 0, policy.expiresAt),
        };
        await this.save(state);
        return true;
      });
      if (installed) return;
    }
  }
}
