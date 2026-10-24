import { brand } from "../../brand.ts";
import { HomeClient, PoolHome, poolGroupPrefix } from "./control.ts";
import { BackendFailure, object, post, rows, unavailable, type Json } from "./json.ts";

const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function randomSecret(prefix = ""): string {
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Home owns key enforcement. Nothing in this module handles model traffic. */
export class ComputerHome {
  readonly client: HomeClient;
  constructor(client: HomeClient) { this.client = client; }
  async user(person: string): Promise<number> {
    // Stable across renames; neither usernames nor logs contain the person's identity.
    const username = `${brand.setup.id}-${await digest(person)}`;
    const find = async () => rows((await this.client.data("/users")).users).find((row) => row.username === username);
    let user = await find();
    if (!user) {
      // Subscriptions are uncapped by default. Optional per-member caps are a separate control.
      const response = await this.client.response("/users", post({ username, credits_unlimited: true }));
      if (!response.ok && response.status !== 409) throw new BackendFailure(response.status);
      await response.body?.cancel();
      user = await find();
    }
    if (!id(user?.id)) return unavailable();
    return user.id;
  }
  async group(pool: string): Promise<number> {
    if (typeof pool !== "string" || !pool.trim()) return unavailable();
    const name = `${poolGroupPrefix}${pool}`;
    let groups = (await this.client.allPoolGroups()).filter((group) => group.channel_name === name);
    if (!groups.length) {
      const response = await this.client.response("/channel-groups", post({ channel_name: name }));
      if (!response.ok && response.status !== 409) throw new BackendFailure(response.status);
      await response.body?.cancel();
      groups = (await this.client.allPoolGroups()).filter((group) => group.channel_name === name);
    }
    if (!groups.length || !id(groups[0]?.id)) return unavailable();
    return groups[0].id;
  }
  private async writeScopedKey(pool: string, input: Json, method: "POST" | "PATCH"): Promise<Json> {
    const group = await this.group(pool);
    // Home treats empty channels as unrestricted. Verify the exact pool group at the write boundary.
    if (!id(group) || !(await this.client.allPoolGroups()).some((row) =>
      row.id === group && row.channel_name === `${poolGroupPrefix}${pool}`)) return unavailable();
    const channels: [number] = [group];
    return this.client.data("/access/api-keys", { ...post({ ...input, channels }), method });
  }
  async mint(person: string, pool: string, computer: string): Promise<{ key: string; keyId: number; userId: number }> {
    const userId = await this.user(person);
    const key = randomSecret(brand.setup.keyPrefix);
    const data = await this.writeScopedKey(pool, {
      api_key: key, display_name: `${brand.setup.id}:${computer}`, user_id: userId,
      model_groups: [],
    }, "POST");
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
  async rebind(keyId: number, pool: string): Promise<void> {
    await this.writeScopedKey(pool, { api_key_id: keyId }, "PATCH");
  }
  async revoke(keyId: number): Promise<void> {
    const response = await this.client.response(`/access/api-keys?id=${keyId}`, { method: "DELETE" });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => ({}));
      if (response.status !== 404 || !object(error) || error.error !== "api_key_not_found") throw new BackendFailure(response.status);
    }
    if (!response.bodyUsed) await response.body?.cancel();
  }
  async observed(pool: string, keyId: number, since: string): Promise<string | null> {
    // PoolHome owns the exact-key and credential-membership filters used by the usage API.
    const response = await new PoolHome(this.client, pool).usage({ key: keyId, status: "success", limit: 20 });
    const dates = response.records.map((row) => row.at).filter((at) => Date.parse(at) >= Date.parse(since)).sort();
    return dates[0] ?? null;
  }
}
