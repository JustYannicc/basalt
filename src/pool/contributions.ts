import type { ControlStorage } from "./attribution.ts";
import { HomeClient, PoolHome } from "./control.ts";
import { fail, text } from "./json.ts";

interface Contribution { pool: string; id: string; addedBy: string; owner?: string; suspended?: boolean; departed?: boolean }
interface RemovalReceipt { pool: string; id: string; owner: string; expiresAt: number }
interface State {
  accounts: Record<string, Contribution>;
  audiences: Record<string, string[]>;
  deletedPeople: string[];
  removals?: Record<string, RemovalReceipt>;
}
export interface ContributionAudience { pool: string; users: readonly string[] }
const storageKey = "pool-contributions-v1";
const key = (pool: string, id: string) => JSON.stringify([pool, id]);
// Retain receipts for seven days to cover normal host retries and restarts.
const removalReceiptTtl = 7 * 24 * 60 * 60_000;

/** Mutations run inside PoolControl's attribution queue, including access changes. */
export class Contributions {
  private storage: Pick<ControlStorage, "get" | "put">;
  private client: HomeClient;
  private now: () => number;
  constructor(storage: Pick<ControlStorage, "get" | "put">, client: HomeClient, now = Date.now) {
    this.storage = storage; this.client = client; this.now = now;
  }
  private async load(): Promise<State> {
    const state = await this.storage.get<State>(storageKey) ?? { accounts: {}, audiences: {}, deletedPeople: [] };
    // Preserve signed evidence from before this field existed before replacing an audience.
    for (const record of Object.values(state.accounts)) if (!this.allowed(state, record)) record.departed = true;
    const now = this.now();
    for (const [receiptKey, receipt] of Object.entries(state.removals ?? {})) {
      if (receipt.expiresAt <= now) delete state.removals![receiptKey];
    }
    // Reads also run outside the mutation queue. Persist pruning only on a later mutation.
    return state;
  }
  private save(state: State) { return this.storage.put(storageKey, state); }
  async ownership(pool: string): Promise<{ assigned: string[]; other: string[] }> {
    const records = Object.values((await this.load()).accounts);
    return { assigned: records.map((record) => record.id), other: records.filter((record) => record.pool !== pool).map((record) => record.id) };
  }
  async contributors(pool: string): Promise<Record<string, string>> {
    return Object.fromEntries(Object.values((await this.load()).accounts)
      .filter((record) => record.pool === pool).map((record) => [record.id, record.addedBy]));
  }
  async owns(pool: string, id: string, caller?: string): Promise<boolean> {
    const record = (await this.load()).accounts[key(pool, id)];
    return !!record && (caller === undefined || record.addedBy === caller);
  }
  async departed(pool: string, id: string, owner: string): Promise<boolean> {
    const state = await this.load();
    const record = state.accounts[key(pool, id)];
    return !!record && record.addedBy !== owner && (record.departed === true || !this.allowed(state, record));
  }
  async completedRemoval(pool: string, id: string, owner: string): Promise<boolean> {
    const state = await this.load();
    const receipt = state.removals?.[key(pool, id)];
    // A receipt only acknowledges absence. It never authorizes deleting a live contribution.
    return receipt?.owner === owner && !Object.values(state.accounts).some((record) => record.id === id);
  }
  async forget(pool: string, id: string, owner: string): Promise<void> {
    const state = await this.load();
    const record = state.accounts[key(pool, id)];
    if (record && record.addedBy !== owner && (record.departed === true || !this.allowed(state, record))) {
      (state.removals ??= {})[key(pool, id)] = { pool, id, owner, expiresAt: this.now() + removalReceiptTtl };
    }
    delete state.accounts[key(pool, id)];
    // Replace this departure's authority with its inert receipt in the same durable write.
    await this.save(state);
  }
  private allowed(state: State, record: Contribution): boolean {
    const users = state.audiences[JSON.stringify(record.pool)];
    return !state.deletedPeople.includes(record.addedBy) && (!record.owner || !state.deletedPeople.includes(record.owner)) && (!users || users.includes(record.addedBy));
  }
  async add(home: PoolHome, ids: string[], caller: string | undefined, known?: Parameters<PoolHome["add"]>[1]): Promise<void> {
    const state = await this.load();
    // Home ids are global. Reuse in any pool starts a new contribution, even for the same person.
    for (const [receiptKey, receipt] of Object.entries(state.removals ?? {})) {
      if (ids.includes(receipt.id)) delete state.removals![receiptKey];
    }
    // Sessions from before contribution attribution remain legacy and owner-only.
    if (!caller) { await this.save(state); await home.add(ids, known); return; }
    for (const id of ids) {
      const record: Contribution = state.accounts[key(home.pool, id)] ??= { pool: home.pool, id, addedBy: caller, owner: home.owner };
      if (record.addedBy !== caller) return fail(403, "not_owner", "This account was added by someone else.");
      record.suspended = !this.allowed(state, record);
      if (record.suspended) record.departed = true;
    }
    await this.save(state); // Contributor and access decision survive a lost membership response.
    await home.add(ids.filter((id) => !state.accounts[key(home.pool, id)]!.suspended), known);
  }
  async reconcile(audiences: readonly ContributionAudience[], deletedPerson?: string): Promise<void> {
    const state = await this.load();
    if (deletedPerson && !state.deletedPeople.includes(deletedPerson)) state.deletedPeople.push(deletedPerson);
    for (const audience of audiences) {
      state.audiences[JSON.stringify(audience.pool)] = [...audience.users];
      // The directory accepts restored people only after deletion refusals expire.
      state.deletedPeople = state.deletedPeople.filter((user) => !audience.users.includes(user));
    }
    const selected = new Set(audiences.map((audience) => audience.pool));
    const pools = new Map<string, Contribution[]>();
    for (const record of Object.values(state.accounts)) {
      if (!selected.has(record.pool) && !(deletedPerson && (record.addedBy === deletedPerson || record.owner === deletedPerson))) continue;
      const records = pools.get(record.pool) ?? [];
      records.push(record);
      pools.set(record.pool, records);
      // Retain the signed departure until forget() replaces it with a completed receipt.
      // Re-sharing can restore routing, but the host may still have an old unlink job.
      if (!this.allowed(state, record)) record.departed = true;
    }
    await this.save(state); // Departure authority survives a failed detach and later re-sharing.
    for (const [pool, records] of pools) {
      const detach = records.filter((record) => !this.allowed(state, record));
      if (!detach.length) continue;
      for (const record of detach) record.suspended = true;
      await this.save(state); // Mark before deleting; rollback can recover an ambiguous delete.
      await new PoolHome(this.client, pool).detach(detach.map((record) => record.id));
    }
    for (const [pool, records] of pools) {
      const restore = records.filter((record) => record.suspended && this.allowed(state, record));
      if (!restore.length) continue;
      const home = new PoolHome(this.client, pool);
      try {
        // Durable unlink may have already removed credentials. Never recreate them.
        const existing = new Set((await home.credentials()).map((row) => text(row.id)));
        await home.add(restore.filter((record) => existing.has(record.id)).map((record) => record.id));
      } catch {
        // Restoration can retry on this pool's next audience without blocking revocation.
        continue;
      }
      for (const record of restore) delete record.suspended;
      await this.save(state);
    }
  }
}
