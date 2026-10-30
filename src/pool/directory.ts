import type { PoolChoice } from "../../apps/pool/ui/computer-types.ts";
import { accessGrace, type AccessApplied, type AccessEnvelope, type PoolAudience } from "./access-contract.ts";
import type { ComputerHome } from "./computer-home.ts";
import { boundPools, type ComputerStorage, type Registry, type StoredComputer } from "./computer-registry.ts";
import { fail, object, text } from "./json.ts";
import { setupTtl, type SetupIntent } from "./setup-links.ts";
import type { PoolClaims } from "./token.ts";

interface PoolEntry extends Omit<PoolAudience, "users" | "authorization" | "managers"> {
  users: string[]; at: number; pending: string[]; provisioned?: string[]; refuseBefore?: number; deleted?: boolean;
  ownerSource?: "token" | "audience" | "own";
  authorization?: PoolAudience["authorization"]; managers?: readonly string[];
}
interface DirectoryState {
  pools: Record<string, PoolEntry>; refusals: Record<string, number>; people: Record<string, number>; refusalsVersion?: 2;
}
const key = (value: unknown) => JSON.stringify(value);
const storageKey = "pool-directory-v1";

/** All callers run under the computer registry's queue. */
export class PoolDirectory {
  private storage: ComputerStorage;
  private state: DirectoryState;
  private constructor(storage: ComputerStorage, state: DirectoryState) { this.storage = storage; this.state = state; }
  static async load(storage: ComputerStorage, now: number) {
    const state = await storage.get<DirectoryState>(storageKey) ?? { pools: {}, refusals: {}, people: {}, refusalsVersion: 2 };
    const directory = new PoolDirectory(storage, state);
    if (state.refusalsVersion !== 2) {
      for (const person of Object.keys(state.people)) state.people[person] = now + accessGrace;
      for (const pool of Object.values(state.pools)) {
        if (pool.deleted) pool.refuseBefore = now + accessGrace;
        delete pool.deleted;
      }
      state.refusalsVersion = 2;
      await directory.save();
    }
    return directory;
  }
  private save() { return this.storage.put(storageKey, this.state); }
  entry(pool: string) { return this.state.pools[key(pool)]; }
  allowed(pool: string, user: string, issuedAt: number): boolean {
    return issuedAt >= Math.max(this.entry(pool)?.refuseBefore ?? -Infinity,
      this.state.people[key(user)] ?? -Infinity, this.state.refusals[key([pool, user])] ?? -Infinity);
  }
  check(intent: SetupIntent) {
    if (!this.allowed(intent.pool, intent.user, intent.expiresAt - setupTtl))
      return fail(403, "unauthorized", "Access to this pool was removed. Open setup again from an available pool.");
    const entry = this.entry(intent.pool);
    if (entry?.authorization === "executor-app-v1" && !entry.users.includes(intent.user))
      return fail(403, "unauthorized", "This pool is not available to you.");
  }
  permissions(pool: string, user: string) {
    const entry = this.entry(pool);
    if (entry?.authorization !== "executor-app-v1") return undefined;
    return { canUse: entry.users.includes(user), canManage: entry.managers?.includes(user) === true };
  }
  async learn(claims: PoolClaims, user: string) {
    const existing = this.entry(claims.pool);
    if (existing?.authorization === "executor-app-v1") return;
    if (!existing || !existing.ownerSource || existing.ownerSource === "own") {
      // Unverified metadata must not keep its claimed owner or membership after trusted claims arrive.
      this.state.pools[key(claims.pool)] = { ...claims, name: existing?.name ?? "", users: [user],
        at: existing?.at ?? -1, pending: [], refuseBefore: existing?.refuseBefore, ownerSource: "token" };
    }
    else if (!existing.users.includes(user)) existing.users = [...existing.users, user];
    await this.save();
  }
  /** The host signs this metadata, but the person may have supplied its organization fields. */
  async learnOwn(value: unknown, user: string, now: number) {
    if (!object(value)) return;
    const pool = text(value.pool), organization = text(value.organization);
    if (!pool?.trim() || !organization?.trim() || !this.allowed(pool, user, now)) return;
    const existing = this.entry(pool);
    if (existing && (existing.owner !== user || existing.organization !== organization)) return;
    if (existing?.authorization === "executor-app-v1") return;
    if (!existing) this.state.pools[key(pool)] = { pool, organization, owner: user,
      name: "", users: [user], at: -1, pending: [], ownerSource: "own" };
    else if (!existing.users.includes(user)) existing.users = [...existing.users, user];
    await this.save();
  }
  choices(user: string, issuedAt: number, own: PoolClaims): PoolChoice[] {
    const pools = Object.values(this.state.pools).filter((pool) =>
      (pool.users.includes(user) || (pool.authorization !== "executor-app-v1"
        && (pool.owner === user || pool.pool === own.pool))) && this.allowed(pool.pool, user, issuedAt));
    if (!this.entry(own.pool) && this.allowed(own.pool, user, issuedAt))
      return [...pools.map((pool) => ({ id: pool.pool, name: pool.name, mine: pool.owner === user })), { id: own.pool, name: "", mine: own.owner === user }];
    return pools.map((pool) => ({ id: pool.pool, name: pool.name, mine: pool.owner === user }));
  }
  async prune(now: number) {
    for (const refusals of [this.state.refusals, this.state.people]) {
      for (const [id, before] of Object.entries(refusals)) if (now > before + setupTtl) delete refusals[id];
    }
    for (const pool of Object.values(this.state.pools)) {
      if (pool.refuseBefore !== undefined && now > pool.refuseBefore + setupTtl) delete pool.refuseBefore;
    }
    await this.save();
  }
  private refuse(pool: string, user: string, now: number) {
    const id = key([pool, user]);
    this.state.refusals[id] = Math.max(this.state.refusals[id] ?? 0, now + accessGrace);
  }
  private deletePool(pool: string, at: number, registry: Registry, now: number, remove: Set<StoredComputer>) {
    const old = this.entry(pool);
    for (const user of new Set([old?.owner ?? "", ...(old?.users ?? [])])) if (user) this.refuse(pool, user, now);
    for (const computer of Object.values(registry)) {
      if (!boundPools(computer).includes(pool)) continue;
      this.refuse(pool, computer.user, now);
      remove.add(computer);
    }
    this.state.pools[key(pool)] = { pool, owner: old?.owner ?? "", organization: old?.organization ?? "",
      name: old?.name ?? "", users: [], at: Math.max(at, old?.at ?? -1), pending: [],
      refuseBefore: Math.max(old?.refuseBefore ?? 0, now + accessGrace), ownerSource: old?.ownerSource,
      ...(old?.authorization === "executor-app-v1" ? { authorization: old.authorization, managers: [] } : {}) };
  }
  private confirmsPending(pool: string, user: string, at: number, registry: Registry): boolean {
    // A failed member removal can roll back before grace expires. Deletions still refuse it.
    return at >= Math.max(this.entry(pool)?.refuseBefore ?? -Infinity, this.state.people[key(user)] ?? -Infinity)
      && Object.values(registry).some((computer) => computer.removalPending && computer.user === user
        && boundPools(computer).includes(pool) && at > (computer.removalAt ?? Infinity));
  }
  private async recover(computer: StoredComputer, home: ComputerHome, now: number): Promise<boolean> {
    const pools = boundPools(computer);
    if (!pools.every((id) => {
      const pool = this.entry(id);
      return pool && pool.at > (computer.removalAt ?? Infinity) && pool.users.includes(computer.user)
        && pool.at >= Math.max(pool.refuseBefore ?? -Infinity, this.state.people[key(computer.user)] ?? -Infinity);
    })) return false;
    const keys = await home.find(computer.id);
    const exists = computer.keyId ? keys.includes(computer.keyId) : keys.length > 0;
    if (exists) {
      computer.keyId ??= keys[0];
      computer.state = computer.state === "revoked" ? "revoked" : computer.beforeRemoval?.state ?? "revoking";
      if (computer.state === "issuing" && (computer.beforeRemoval?.link?.expiresAt ?? 0) > now)
        computer.link = computer.beforeRemoval!.link;
    } else {
      computer.state = "removed";
      computer.removedAt ??= new Date(now).toISOString();
      delete computer.switching;
      delete computer.switchingTo;
    }
    for (const pool of pools) delete this.state.refusals[key([pool, computer.user])];
    delete computer.removalPending;
    delete computer.removalAt;
    delete computer.beforeRemoval;
    await this.save();
    return true;
  }
  async apply(change: AccessEnvelope, registry: Registry, home: ComputerHome, now: number,
    saveRegistry: () => Promise<unknown>): Promise<AccessApplied> {
    for (const computer of Object.values(registry)) {
      if (computer.removalPending && computer.removalAt === undefined)
        computer.removalAt = Math.max(-1, ...boundPools(computer).map((pool) => this.entry(pool)?.at ?? -1));
    }
    await this.prune(now);
    const selected = new Set<string>();
    const remove = new Set<StoredComputer>();
    if (change.action === "audience") {
      for (const audience of change.pools) {
        const old = this.entry(audience.pool);
        if (old && change.at < old.at) continue;
        // A projection computed during removal must not restore the person or pool.
        if (change.at < (old?.refuseBefore ?? -Infinity)) continue;
        // A retained writer may revoke access, but cannot restore a grant the native policy denied.
        const legacy = old?.authorization === "executor-app-v1" && audience.authorization === undefined;
        const projected = [...new Set(legacy ? audience.users.filter((user) => old.users.includes(user))
          : audience.authorization === "executor-app-v1" ? audience.users : [audience.owner, ...audience.users])];
        const users = projected.filter((user) => old?.users.includes(user) || this.allowed(audience.pool, user, change.at)
          || this.confirmsPending(audience.pool, user, change.at, registry));
        for (const user of old?.users ?? []) if (!projected.includes(user)) this.refuse(audience.pool, user, now);
        const pending = new Set(old?.pending ?? []);
        for (const user of users) if (user !== audience.owner && !old?.provisioned?.includes(user)) pending.add(user);
        this.state.pools[key(audience.pool)] = { ...audience, users, at: change.at, provisioned: old?.provisioned ?? [],
          pending: [...pending].filter((user) => users.includes(user)), refuseBefore: old?.refuseBefore, ownerSource: "audience" };
        if (legacy) {
          this.state.pools[key(audience.pool)]!.authorization = old.authorization;
          this.state.pools[key(audience.pool)]!.managers = old.managers;
        }
        selected.add(audience.pool);
        for (const computer of Object.values(registry)) {
          if (!boundPools(computer).includes(audience.pool) || users.includes(computer.user)) continue;
          this.refuse(audience.pool, computer.user, now);
          remove.add(computer);
        }
      }
    } else if (change.action === "pool-deleted") {
      this.deletePool(change.pool, change.at, registry, now, remove);
      selected.add(change.pool);
    } else {
      this.state.people[key(change.user)] = Math.max(this.state.people[key(change.user)] ?? 0, now + accessGrace);
      for (const pool of Object.values(this.state.pools)) {
        if (pool.owner === change.user && (pool.ownerSource === "token" || pool.ownerSource === "audience")) {
          this.deletePool(pool.pool, change.at, registry, now, remove);
          selected.add(pool.pool);
          continue;
        }
        pool.users = pool.users.filter((user) => user !== change.user);
        pool.pending = pool.pending.filter((user) => user !== change.user);
        pool.provisioned = pool.provisioned?.filter((user) => user !== change.user);
        if (pool.managers) pool.managers = pool.managers.filter((user) => user !== change.user);
        this.refuse(pool.pool, change.user, now);
      }
      for (const computer of Object.values(registry)) if (computer.user === change.user) remove.add(computer);
    }
    await this.save(); // Refusals survive every backend failure, but expire after old intents do.
    for (const computer of remove) {
      if (computer.state === "revoked" || (computer.state === "removed" && !computer.removalPending)) continue;
      if (!computer.removalPending) computer.beforeRemoval = { state: computer.state, link: computer.link };
      computer.removalPending = true;
      computer.removalAt = Math.max(computer.removalAt ?? -1, change.at);
      computer.state = "revoking";
      delete computer.link;
    }
    await saveRegistry();
    let revoked = 0;
    for (const computer of Object.values(registry)) {
      if (!computer.removalPending || (!boundPools(computer).some((pool) => selected.has(pool))
        && !(change.action === "person-deleted" && computer.user === change.user))) continue;
      if (change.action === "audience" && !remove.has(computer)) {
        if (await this.recover(computer, home, now)) { await saveRegistry(); continue; }
        // A partial confirmation must not delete a key while other bindings remain uncertain.
        if (boundPools(computer).filter((pool) => selected.has(pool))
          .every((pool) => this.entry(pool)?.users.includes(computer.user))) continue;
      }
      const keys = computer.keyId ? [computer.keyId] : await home.find(computer.id);
      for (const id of keys) { await home.revoke(id); revoked++; }
      computer.state = "removed"; computer.removedAt ??= new Date(now).toISOString();
      delete computer.removalPending;
      delete computer.removalAt;
      delete computer.beforeRemoval;
      delete computer.switching;
      delete computer.switchingTo;
      await saveRegistry();
    }
    if (change.action === "person-deleted") revoked += await home.deletePerson(change.user);
    const provisioned = await this.provisionPending(home, selected);
    return { revoked, provisioned };
  }
  async provisionPending(home: ComputerHome, selected = new Set(Object.values(this.state.pools).map((pool) => pool.pool))): Promise<number> {
    let provisioned = 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Pool provisioning budget exceeded")); }, 2_000);
    });
    try {
      for (const poolId of selected) {
        const pool = this.entry(poolId)!;
        for (const user of [...pool.pending]) {
          if (controller.signal.aborted) return provisioned;
          try {
            let created = false;
            await Promise.race([home.user(user, pool.pool, () => { created = true; }, controller.signal), expired]);
            if (created) provisioned++;
            pool.provisioned = [...(pool.provisioned ?? []), user];
            pool.pending = pool.pending.filter((person) => person !== user);
          } catch (error) {
            if (controller.signal.aborted) return provisioned;
            console.error("Pool member provisioning failed; retained for retry", { pool: poolId, user, error });
          }
          await this.save();
        }
      }
    } catch (error) {
      console.error("Pool member provisioning failed; retained for retry", { error });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return provisioned;
  }
}
