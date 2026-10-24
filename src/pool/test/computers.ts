import assert from "node:assert/strict";
import { callerHeader } from "../../../apps/pool/contract.ts";
import { accessPrefix, accessTtl, type AccessChange } from "../access-contract.ts";
import { ComputerHome } from "../computer-home.ts";
import { backendUserName } from "../backend-users.ts";
import { Computers } from "../computers.ts";
import { HomeClient } from "../control.ts";
import type { ComputerStorage, Registry } from "../computer-registry.ts";
import { signEnvelope, signPoolToken, type PoolClaims } from "../token.ts";

export const signingKey = "ab".repeat(32);
export const previousKey = "cd".repeat(32);
export const owner = "user-owner";
export const member = "user-member";
export const pool = { pool: "pool-a", owner, organization: "organization-a", name: "First pool", users: [owner, member] };
type Row = Record<string, unknown>;
export class Memory implements ComputerStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
}

export function fixture() {
  const storage = new Memory();
  let time = Date.parse("2026-01-01T00:00:00Z");
  const server = {
    users: [] as Row[], keys: [] as Row[], groups: [] as Row[], calls: [] as { path: string; method: string; body?: Row }[],
    revokeFailure: false, userFailure: false, deleteUserFailure: false, patchReplyFailure: false, patchFailure: false, mintReplyFailure: false,
    revokeGate: undefined as Promise<void> | undefined, onRevoke: undefined as (() => void) | undefined,
    nextKey: 70,
  };
  const events: [string, string][] = [];
  const onProductEvent = (event: string, accountId: string) => { events.push([event, accountId]); };
  const home = new ComputerHome(new HomeClient(async (path, init) => {
    const url = new URL(`https://home.example${path}`);
    const endpoint = url.pathname.slice("/v8/management".length);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Row : undefined;
    server.calls.push({ path: endpoint, method, body });
    if (endpoint === "/users") {
      if (method === "POST") {
        if (server.userFailure) return Response.json({ error: "failed" }, { status: 500 });
        server.users.push({ ...body, id: server.users.length + 1 });
      }
      return Response.json({ users: server.users });
    }
    if (endpoint.startsWith("/users/") && method === "DELETE") {
      if (server.deleteUserFailure) return Response.json({ error: "failed" }, { status: 500 });
      const userId = Number(endpoint.split("/").at(-1));
      assert.equal(server.keys.filter((key) => key.user_id === userId).length, 0, "keys must go before the user");
      server.users = server.users.filter((user) => user.id !== userId);
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/channel-groups") {
      if (method === "POST") server.groups.push({ ...body, id: server.groups.length + 10 });
      return Response.json({ channel_groups: server.groups });
    }
    if (endpoint === "/access/api-keys") {
      if (method === "POST") {
        const key = { ...body, api_key_id: server.nextKey++, id: server.nextKey - 1 };
        server.keys.push(key);
        if (server.mintReplyFailure) return Response.json({ error: "failed" }, { status: 500 });
        return Response.json({ api_key: key });
      }
      if (method === "PATCH") {
        if (server.patchFailure) return Response.json({ error: "failed" }, { status: 500 });
        assert.ok(Array.isArray(body?.channels) && body.channels.length === 1);
        const key = server.keys.find((key) => key.api_key_id === body?.api_key_id);
        assert.ok(key);
        Object.assign(key, body);
        if (server.patchReplyFailure) return Response.json({ error: "failed" }, { status: 500 });
        return Response.json({ status: "ok" });
      }
      if (method === "DELETE") {
        server.onRevoke?.();
        await server.revokeGate;
        if (server.revokeFailure) return Response.json({ error: "failed" }, { status: 500 });
        const keyId = Number(url.searchParams.get("id"));
        const exists = server.keys.some((key) => key.api_key_id === keyId);
        server.keys = server.keys.filter((key) => key.api_key_id !== keyId);
        return exists ? Response.json({ status: "ok" }) : Response.json({ error: "api_key_not_found" }, { status: 404 });
      }
      return Response.json({ items: server.keys });
    }
    if (endpoint === "/observability/request-events") return Response.json({ records: [] });
    throw new Error(`Unexpected Home request: ${method} ${endpoint}`);
  }), onProductEvent);
  home.observed = async () => null;
  const make = () => new Computers({ storage, home, signingKey, previousSigningKey: previousKey, now: () => time, origin: "https://setup.example", onProductEvent });
  let computers = make();
  async function context(user = member, claims: PoolClaims = pool) {
    const token = await signPoolToken(signingKey, claims);
    return computers.context(new Request("https://pool.example/pool/v1/setup-context", {
      headers: { Authorization: `Bearer ${token}`, [callerHeader]: user },
    }));
  }
  async function action(action: string, user: string, intent?: string, extra: Row = {}) {
    const envelope = await signEnvelope(signingKey, "sbs1", { ...extra, action, user, intent, expiresAt: time + 10_000 });
    return computers.handle(new Request(`https://pool.example/__setup/v1/${action}`, { method: "POST", body: JSON.stringify({ envelope }) }));
  }
  async function access(change: AccessChange, at = time, secret = signingKey, expiresAt = time + accessTtl, prefix = accessPrefix) {
    const envelope = await signEnvelope(secret, prefix, { ...change, at, expiresAt });
    return computers.access(new Request("https://pool.example/pool/v1/access", { method: "POST", body: JSON.stringify({ envelope }) }));
  }
  async function intent(user = member, claims: PoolClaims = pool) {
    const response = await context(user, claims);
    assert.equal(response.status, 200, await response.clone().text());
    return String((await response.json() as Row).intent);
  }
  async function create(user = member, claims: PoolClaims = pool, active = true) {
    const setup = await intent(user, claims);
    const response = await action("links", user, setup, { name: "Laptop", toolsKeyId: `tools-${user}`, toolsToken: `fake-tools-${user}` });
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json() as { computer: { id: string }; token: string };
    if (active) assert.equal((await action("claim", user, undefined, { token: value.token, format: "json" })).status, 200);
    return { ...value, intent: setup };
  }
  return { storage, server, home, events, context, action, access, intent, create,
    expire: () => computers.expire(), now: () => time, advance: (ms: number) => { time += ms; }, restart: () => { computers = make(); },
    registry: async () => (await storage.get<Registry>("computer-registry-v1")) ?? {},
    userName: (user: string, claims: { pool: string } = pool) => backendUserName(user, claims.pool),
  };
}
