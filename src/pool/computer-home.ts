import { brand } from "../../brand.ts";
import { HomeClient, PoolHome, poolGroupPrefix } from "./control.ts";
import { BackendFailure, object, post, rows, unavailable, type Json } from "./json.ts";
import { emitProductEvent, type ProductEventCallback } from "../setup/product-events.ts";
import { backendUserName, personPrefix } from "./backend-users.ts";

const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export { digest } from "./backend-users.ts";
export function randomSecret(prefix = ""): string {
  return (
    prefix +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

/** Home owns key enforcement. Nothing in this module handles model traffic. */
export class ComputerHome {
  readonly client: HomeClient;
  private onProductEvent?: ProductEventCallback;
  constructor(client: HomeClient, onProductEvent?: ProductEventCallback) {
    this.client = client;
    this.onProductEvent = onProductEvent;
  }
  private async findUser(person: string, pool: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (typeof pool !== "string" || !pool.trim()) return unavailable();
    const username = await backendUserName(person, pool);
    return rows((await this.client.data("/users", { signal })).users).find(
      (row) => row.username === username,
    );
  }
  async user(
    person: string,
    pool: string,
    created?: () => void,
    signal?: AbortSignal,
  ): Promise<number> {
    if (typeof pool !== "string" || !pool.trim()) return unavailable();
    const username = await backendUserName(person, pool);
    let user = await this.findUser(person, pool, signal);
    signal?.throwIfAborted();
    let provisioned = false;
    if (!user) {
      // Home v1.1.6 internal/cluster/user_period_limit.go:853-867 still checks period caps
      // for unlimited users. A distinct user keeps every cap within its own pool.
      const response = await this.client.response("/users", {
        ...post({ username, credits_unlimited: true }),
        signal,
      });
      if (!response.ok && response.status !== 409) throw new BackendFailure(response.status);
      provisioned = response.ok;
      await response.body?.cancel();
      user = await this.findUser(person, pool, signal);
    }
    signal?.throwIfAborted();
    if (!id(user?.id)) return unavailable();
    if (provisioned) created?.();
    return user.id;
  }
  async group(pool: string, accountId?: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    if (typeof pool !== "string" || !pool.trim()) return unavailable();
    const name = `${poolGroupPrefix}${pool}`;
    let groups = (await this.client.allPoolGroups(signal)).filter(
      (group) => group.channel_name === name,
    );
    let created = false;
    if (!groups.length) {
      const response = await this.client.response("/channel-groups", {
        ...post({ channel_name: name }),
        signal,
      });
      if (!response.ok && response.status !== 409) throw new BackendFailure(response.status);
      created = response.ok;
      await response.body?.cancel();
      groups = (await this.client.allPoolGroups(signal)).filter(
        (group) => group.channel_name === name,
      );
    }
    if (!groups.length || !id(groups[0]?.id)) return unavailable();
    if (created && accountId) emitProductEvent(this.onProductEvent, "pool_created", accountId);
    return groups[0].id;
  }
  private async writeScopedKey(
    pool: string,
    input: Json,
    method: "POST" | "PATCH",
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<Json> {
    const group = await this.group(pool, accountId, signal);
    // Home treats empty channels as unrestricted. Verify the exact pool group at the write boundary.
    if (
      !id(group) ||
      !(await this.client.allPoolGroups(signal)).some(
        (row) => row.id === group && row.channel_name === `${poolGroupPrefix}${pool}`,
      )
    )
      return unavailable();
    const channels: [number] = [group];
    return this.client.data("/access/api-keys", {
      ...post({ ...input, channels }),
      method,
      signal,
    });
  }
  /** `owner` is credited if this mint creates the pool's group; a member's first mint can. */
  async mint(
    person: string,
    pool: string,
    computer: string,
    owner = person,
  ): Promise<{ key: string; keyId: number; userId: number }> {
    const userId = await this.user(person, pool);
    const key = randomSecret(brand.setup.keyPrefix);
    const data = await this.writeScopedKey(
      pool,
      {
        api_key: key,
        display_name: `${brand.setup.id}:${computer}`,
        user_id: userId,
        model_groups: [],
      },
      "POST",
      owner,
    );
    const created = data.api_key;
    if (!object(created) || !id(created.api_key_id ?? created.id) || created.user_id !== userId)
      return unavailable();
    return { key, keyId: (created.api_key_id ?? created.id) as number, userId };
  }
  /** One short app request uses the same person/pool user and caps as that person's computer. */
  async mintAppModel(
    person: string,
    pool: string,
    label: string,
    owner: string,
    signal: AbortSignal,
  ) {
    const userId = await this.user(person, pool, undefined, signal);
    signal.throwIfAborted();
    const key = randomSecret(brand.setup.keyPrefix);
    const data = await this.writeScopedKey(
      pool,
      { api_key: key, display_name: label, user_id: userId, model_groups: [] },
      "POST",
      owner,
      signal,
    );
    const created = data.api_key;
    const keyId = object(created) ? (created.api_key_id ?? created.id) : undefined;
    if (!id(keyId) || !object(created) || created.user_id !== userId) return unavailable();
    return { key, keyId };
  }
  async findAppModel(label: string) {
    return rows((await this.client.data("/access/api-keys")).items)
      .filter((key) => key.display_name === label)
      .map((key) => key.api_key_id ?? key.id)
      .filter(id);
  }
  /** Used after an interrupted create, never returned through a public endpoint. */
  async find(computer: string): Promise<number[]> {
    const keys = rows((await this.client.data("/access/api-keys")).items);
    return keys
      .filter((key) => key.display_name === `${brand.setup.id}:${computer}`)
      .map((key) => key.api_key_id ?? key.id)
      .filter(id);
  }
  async rebind(keyId: number, pool: string, person: string, accountId?: string): Promise<number> {
    const userId = await this.user(person, pool);
    // Home v1.1.6 internal/cluster/management/api_keys.go:79-98 accepts both in one PATCH.
    await this.writeScopedKey(pool, { api_key_id: keyId, user_id: userId }, "PATCH", accountId);
    return userId;
  }
  async revoke(keyId: number): Promise<void> {
    const response = await this.client.response(`/access/api-keys?id=${keyId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => ({}));
      if (response.status !== 404 || !object(error) || error.error !== "api_key_not_found")
        throw new BackendFailure(response.status);
    }
    if (!response.bodyUsed) await response.body?.cancel();
  }
  async deletePerson(person: string): Promise<number> {
    const prefix = await personPrefix(person);
    const users = rows((await this.client.data("/users")).users).filter(
      (row) => typeof row.username === "string" && row.username.startsWith(prefix),
    );
    if (!users.length) return 0;
    if (users.some((user) => !id(user.id))) return unavailable();
    const ids = new Set(users.map((user) => user.id));
    const keys = rows((await this.client.data("/access/api-keys")).items).filter((key) =>
      ids.has(key.user_id),
    );
    for (const key of keys) {
      const keyId = key.api_key_id ?? key.id;
      if (!id(keyId)) return unavailable();
      await this.revoke(keyId);
    }
    for (const user of users) {
      const response = await this.client.response(`/users/${user.id}`, { method: "DELETE" });
      if (!response.ok) {
        const error: unknown = await response.json().catch(() => ({}));
        if (response.status !== 404 || !object(error) || error.error !== "not_found")
          throw new BackendFailure(response.status);
      }
      if (!response.bodyUsed) await response.body?.cancel();
    }
    return keys.length;
  }

  async observed(pool: string, keyId: number, since: string): Promise<string | null> {
    return new PoolHome(this.client, pool).firstSuccessfulUsage(keyId, since);
  }
}
