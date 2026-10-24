import type { Registry } from "./computer-registry.ts";
import { brand } from "../../brand.ts";
import { HomeClient, PoolHome, poolGroupPrefix } from "./control.ts";
import { BackendFailure, object, post, rows, unavailable, type Json } from "./json.ts";
import { emitProductEvent, type ProductEventCallback } from "../setup/product-events.ts";
import { backendUserName, digest, parseBackendUserName, personPrefix, scopedUserName } from "./backend-users.ts";

const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export { digest } from "./backend-users.ts";
export function randomSecret(prefix = ""): string {
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Home owns key enforcement. Nothing in this module handles model traffic. */
export class ComputerHome {
  readonly client: HomeClient;
  private onProductEvent?: ProductEventCallback;
  constructor(client: HomeClient, onProductEvent?: ProductEventCallback) {
    this.client = client;
    this.onProductEvent = onProductEvent;
  }
  private async findUser(username: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return rows((await this.client.data("/users", { signal })).users).find((row) => row.username === username);
  }
  async user(person: string, pool: string, created?: () => void, signal?: AbortSignal): Promise<number> {
    if (typeof pool !== "string" || !pool.trim()) return unavailable();
    return this.ensureUser(await backendUserName(person, pool), created, signal);
  }
  private async ensureUser(username: string, created?: () => void, signal?: AbortSignal): Promise<number> {
    let user = await this.findUser(username, signal);
    signal?.throwIfAborted();
    let provisioned = false;
    if (!user) {
      // Home v1.1.6 internal/cluster/user_period_limit.go:853-867 still checks period caps
      // for unlimited users. A distinct user keeps every cap within its own pool.
      const response = await this.client.response("/users", { ...post({ username, credits_unlimited: true }), signal });
      if (!response.ok && response.status !== 409) throw new BackendFailure(response.status);
      provisioned = response.ok;
      await response.body?.cancel();
      user = await this.findUser(username, signal);
    }
    signal?.throwIfAborted();
    if (!id(user?.id)) return unavailable();
    if (provisioned) created?.();
    return user.id;
  }
  async group(pool: string, accountId?: string): Promise<number> {
    if (typeof pool !== "string" || !pool.trim()) return unavailable();
    const name = `${poolGroupPrefix}${pool}`;
    let groups = (await this.client.allPoolGroups()).filter((group) => group.channel_name === name);
    let created = false;
    if (!groups.length) {
      const response = await this.client.response("/channel-groups", post({ channel_name: name }));
      if (!response.ok && response.status !== 409) throw new BackendFailure(response.status);
      created = response.ok;
      await response.body?.cancel();
      groups = (await this.client.allPoolGroups()).filter((group) => group.channel_name === name);
    }
    if (!groups.length || !id(groups[0]?.id)) return unavailable();
    if (created && accountId) emitProductEvent(this.onProductEvent, "pool_created", accountId);
    return groups[0].id;
  }
  private async writeScopedKey(pool: string, input: Json, method: "POST" | "PATCH", accountId?: string): Promise<Json> {
    const group = await this.group(pool, accountId);
    // Home treats empty channels as unrestricted. Verify the exact pool group at the write boundary.
    if (!id(group) || !(await this.client.allPoolGroups()).some((row) =>
      row.id === group && row.channel_name === `${poolGroupPrefix}${pool}`)) return unavailable();
    const channels: [number] = [group];
    return this.client.data("/access/api-keys", { ...post({ ...input, channels }), method });
  }
  /** `owner` is credited if this mint creates the pool's group; a member's first mint can. */
  async mint(person: string, pool: string, computer: string, owner = person): Promise<{ key: string; keyId: number; userId: number }> {
    const userId = await this.user(person, pool);
    const key = randomSecret(brand.setup.keyPrefix);
    const data = await this.writeScopedKey(pool, {
      api_key: key, display_name: `${brand.setup.id}:${computer}`, user_id: userId,
      model_groups: [],
    }, "POST", owner);
    const created = data.api_key;
    if (!object(created) || !id(created.api_key_id ?? created.id) || created.user_id !== userId) return unavailable();
    return { key, keyId: (created.api_key_id ?? created.id) as number, userId };
  }
  /** Used after an interrupted create, never returned through a public endpoint. */
  async find(computer: string): Promise<number[]> {
    const keys = rows((await this.client.data("/access/api-keys")).items);
    return keys.filter((key) => key.display_name === `${brand.setup.id}:${computer}`)
      .map((key) => key.api_key_id ?? key.id).filter(id);
  }
  async rebind(keyId: number, pool: string, person: string, accountId?: string): Promise<number> {
    const userId = await this.user(person, pool);
    // Home v1.1.6 internal/cluster/management/api_keys.go:79-98 accepts both in one PATCH.
    await this.writeScopedKey(pool, { api_key_id: keyId, user_id: userId }, "PATCH", accountId);
    return userId;
  }
  async revoke(keyId: number): Promise<void> {
    const response = await this.client.response(`/access/api-keys?id=${keyId}`, { method: "DELETE" });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => ({}));
      if (response.status !== 404 || !object(error) || error.error !== "api_key_not_found") throw new BackendFailure(response.status);
    }
    if (!response.bodyUsed) await response.body?.cancel();
  }
  /** Called inside Computers.run. One legacy user, at most 20 moves; Home ownership is the resume state. */
  async migrateLegacy(registry: Registry, save: () => Promise<unknown>, person?: string, after = 0): Promise<{ complete: boolean; cursor: number }> {
    const users = rows((await this.client.data("/users")).users);
    const personDigest = person === undefined ? undefined : await digest(person);
    const legacy = users.filter((user) => {
      const name = parseBackendUserName(user.username);
      return name?.pool === null && (personDigest === undefined || name.person === personDigest);
    }).sort((a, b) => Number(a.id) - Number(b.id));
    if (legacy.some((user) => !id(user.id))) return unavailable();
    const user = legacy.find((user) => Number(user.id) > after) ?? legacy[0];
    const keys = legacy.length ? rows((await this.client.data("/access/api-keys")).items) : [];
    const registered = new Map(Object.values(registry).map((computer) => [computer.keyId, computer]));
    const moved = async (keyId: number, userId: number) => {
      const computer = registered.get(keyId);
      if (!computer || computer.userId === userId) return;
      computer.userId = userId;
      await save();
    };
    // Recover a registry save interrupted after Home acknowledged a move.
    const byId = new Map(users.map((user) => [user.id, user]));
    for (const key of keys) {
      const keyId = key.api_key_id ?? key.id, computer = registered.get(keyId as number);
      if (computer && id(keyId) && id(key.user_id)
        && byId.get(key.user_id)?.username === await backendUserName(computer.user, computer.pool))
        await moved(keyId, key.user_id);
    }
    if (!user) return { complete: true, cursor: 0 };
    const name = parseBackendUserName(user.username)!;
    const groups = new Map((await this.client.allPoolGroups()).map((group) => [group.id, group.channel_name.slice(poolGroupPrefix.length)]));
    const owned = keys.filter((key) => key.user_id === user.id);
    const destinations = new Map<string, number>();
    let remaining = owned.length, writes = 0, pending = false;
    for (const key of owned) {
      const channels = key.channels;
      const channelPool = Array.isArray(channels) && channels.length === 1 ? groups.get(channels[0]) : undefined;
      if (!channelPool) { console.warn("Legacy pool key migration skipped: ambiguous channels", key.api_key_id ?? key.id); continue; }
      if (writes >= 20) { pending = true; continue; }
      const keyId = key.api_key_id ?? key.id;
      if (!id(keyId)) return unavailable();
      const computer = registered.get(keyId);
      const pool = computer?.pool ?? channelPool;
      const username = computer ? await backendUserName(computer.user, pool) : await scopedUserName(name.person, pool);
      const userId = destinations.get(username) ?? await this.ensureUser(username);
      destinations.set(username, userId);
      // Home v1.1.6 management/api_keys.go:79-98: keep channel scope in the same write.
      await this.client.data("/access/api-keys", { ...post({ api_key_id: keyId, user_id: userId, channels }), method: "PATCH" });
      await moved(keyId, userId);
      writes++; remaining--;
    }
    if (!remaining) await this.deleteUser(user.id as number);
    return { complete: legacy.length === 1 && !remaining, cursor: pending ? after : user.id as number };
  }
  private async deleteUser(userId: number): Promise<void> {
    const response = await this.client.response(`/users/${userId}`, { method: "DELETE" });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => ({}));
      if (response.status !== 404 || !object(error) || error.error !== "not_found") throw new BackendFailure(response.status);
    }
    if (!response.bodyUsed) await response.body?.cancel();
  }
  async deletePerson(person: string): Promise<number> {
    const prefix = await personPrefix(person);
    const users = rows((await this.client.data("/users")).users).filter((row) =>
      typeof row.username === "string" && (row.username.startsWith(prefix) || row.username === prefix.slice(0, -1)));
    if (!users.length) return 0;
    if (users.some((user) => !id(user.id))) return unavailable();
    const ids = new Set(users.map((user) => user.id));
    const keys = rows((await this.client.data("/access/api-keys")).items).filter((key) => ids.has(key.user_id));
    for (const key of keys) {
      const keyId = key.api_key_id ?? key.id;
      if (!id(keyId)) return unavailable();
      await this.revoke(keyId);
    }
    for (const user of users) await this.deleteUser(user.id as number);
    return keys.length;
  }

  async observed(pool: string, keyId: number, since: string): Promise<string | null> {
    // PoolHome owns the exact-key and credential-membership filters used by the usage API.
    const response = await new PoolHome(this.client, pool).usage({ key: keyId, status: "success", limit: 20 });
    const dates = response.records.map((row) => row.at).filter((at) => Date.parse(at) >= Date.parse(since)).sort();
    return dates[0] ?? null;
  }
}
