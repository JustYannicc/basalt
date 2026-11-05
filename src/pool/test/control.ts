import assert from "node:assert/strict";
import { PoolControl, type ControlStorage } from "../attribution.ts";
import providers from "../providers.json" with { type: "json" };
import { signEnvelope, signPoolToken } from "../token.ts";
import {
  accountAcquisitionPath,
  accountAcquisitionPrefix,
} from "../account-acquisition-contract.ts";

export const signingKey = "ab".repeat(32);
export const provider = providers[0]!.id;
export type Row = Record<string, unknown>;
type Group = { id: number; channel_name: string };
type Member = { id: number; channel_group_id: number; auth_id: string };
type BackendSession = { provider: string; status: string; auth_ids?: string[]; auth_id?: string };
class MemoryStorage implements ControlStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  gets = 0;
  readKeys: string[] = [];
  puts = 0;
  alarmReads = 0;
  async get<T>(key: string): Promise<T | undefined> {
    this.gets++;
    this.readKeys.push(key);
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.puts++;
    this.values.set(key, structuredClone(value));
  }
  async getAlarm() {
    this.alarmReads++;
    return this.alarm;
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
}
class FakeHome {
  calls: { path: string; method: string; body?: BodyInit | null }[] = [];
  files = new Map<string, Row>();
  groups: Group[] = [];
  members: Member[] = [];
  quota: Row[] = [];
  usage: Row[] = [];
  ignoreUsageFilters = false;
  sessions = new Map<string, BackendSession>();
  url = "https://login.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback";
  flow: string | undefined;
  duplicateCreate = false;
  groupCreateStatus = 200;
  override?: (
    path: string,
    init?: RequestInit,
  ) => Response | undefined | Promise<Response | undefined>;
  sequence = 0;
  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    const overridden = await this.override?.(path, init);
    if (overridden) return overridden;
    assert.ok(path.startsWith("/v8/management/"));
    const url = new URL(`https://home.example${path}`);
    const endpoint = url.pathname.slice("/v8/management".length);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    if (endpoint === "/oauth/auth-url") {
      const state = `state-${++this.sequence}`;
      this.sessions.set(state, { provider: url.searchParams.get("provider")!, status: "wait" });
      return Response.json({
        status: "ok",
        state,
        url: this.url,
        flow: this.flow,
        meta: { user_code: "FAKE-CODE" },
      });
    }
    if (endpoint === "/oauth/callback") {
      const redirect = new URL(String(body.redirect_url));
      const state = redirect.searchParams.get("state")!;
      const session = this.sessions.get(state);
      if (!session) return Response.json({ status: "error" }, { status: 404 });
      if (session.status !== "wait") return Response.json({ status: "error" }, { status: 409 });
      if (!redirect.searchParams.get("code") && !redirect.searchParams.get("error"))
        return Response.json({ status: "error" }, { status: 400 });
      if (session.provider !== body.provider)
        return Response.json({ status: "error" }, { status: 400 });
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/oauth/status") {
      assert.ok(url.searchParams.get("state"), "never poll without a backend state");
      const session = this.sessions.get(url.searchParams.get("state")!);
      return session
        ? Response.json(session)
        : Response.json({ status: "error", error: "unknown or expired state" });
    }
    if (endpoint === "/oauth/session") {
      assert.equal(method, "DELETE");
      const state = url.searchParams.get("state")!;
      const session = this.sessions.get(state);
      const cancelled = session?.status === "wait";
      if (cancelled) this.sessions.set(state, { ...session, status: "error" });
      return Response.json({ status: "ok", cancelled });
    }
    if (endpoint === "/credentials") {
      if (method === "POST") {
        if (typeof body.type !== "string" || !body.type)
          return Response.json({ error: "upload_failed" }, { status: 400 });
        if (
          body.uuid !== undefined &&
          (typeof body.uuid !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              body.uuid.trim(),
            ))
        )
          return Response.json({ error: "upload_failed" }, { status: 400 });
        const id = typeof body.uuid === "string" ? body.uuid.trim() : crypto.randomUUID();
        this.files.set(id, { ...body, uuid: id, id, provider: body.type });
        return Response.json({ status: "ok", name: `${id}.json` });
      }
      if (method === "DELETE") {
        return this.files.delete(url.searchParams.get("id")!)
          ? Response.json({ status: "ok" })
          : Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ files: [...this.files.values()] });
    }
    if (endpoint === "/credentials/fields" && method === "PATCH") {
      const file = this.files.get(String(body.id));
      if (!file) return Response.json({}, { status: 404 });
      file.websockets = body.websockets;
      return Response.json({ status: "ok" });
    }
    if (endpoint === "/quota/credentials") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (limit < 1 || limit > 200)
        return Response.json({ error: "INVALID_PAGINATION" }, { status: 400 });
      const ids = new Set(url.searchParams.get("ids")?.split(",") ?? []);
      const quota = this.quota.filter((row) => !ids.size || ids.has(String(row.credential_id)));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return Response.json({
        items: quota.slice(offset, offset + limit),
        total: quota.length,
        limit,
        offset,
      });
    }
    if (endpoint.startsWith("/quota/credentials/")) {
      const id = decodeURIComponent(endpoint.slice("/quota/credentials/".length));
      const credential = this.quota.find((row) => row.credential_id === id) ?? {
        credential_id: id,
      };
      return Response.json({
        credential,
        windows: credential.primary_windows ?? [],
        reset_credits: null,
      });
    }
    if (endpoint === "/usage/records") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      assert.ok(limit >= 1 && limit <= 200);
      const session = url.searchParams.get("session_id");
      const key = url.searchParams.get("client_key_id");
      const status = url.searchParams.get("status");
      const matches = this.usage.filter(
        (row) =>
          this.ignoreUsageFilters ||
          ((!session || row.session_id === session) &&
            (!key || (row.client as Row | undefined)?.api_key_id === Number(key)) &&
            (!status ||
              row.status === status ||
              (/^[1-5][0-9]{2}$/.test(status) && row.status_code === Number(status)))),
      );
      return Response.json({
        items: matches.slice(offset, offset + limit),
        total: matches.length,
        limit,
        offset,
        sort: "timestamp_desc",
      });
    }
    if (endpoint === "/credentials/quota/fetch") {
      assert.equal(method, "POST");
      return Response.json({ accepted: true, credential_id: body.auth_index }, { status: 202 });
    }
    if (endpoint === "/channel-groups") {
      if (method === "POST") {
        const group = {
          id: this.groups.length ? Math.max(...this.groups.map((group) => group.id)) + 10 : 20,
          channel_name: String(body.channel_name),
        };
        this.groups.push(group);
        if (this.duplicateCreate) this.groups.push({ ...group, id: 10 });
        return Response.json({ channel_group: group }, { status: this.groupCreateStatus });
      }
      return Response.json({ channel_groups: this.groups });
    }
    if (endpoint === "/channel-group-details") {
      if (method === "POST") {
        const member = {
          id: this.members.length + 1,
          channel_group_id: Number(body.channel_group_id),
          auth_id: String(body.auth_id),
        };
        this.members.push(member);
        return Response.json({ channel_group_detail: member });
      }
      return Response.json({
        channel_group_details: this.members.filter(
          (item) =>
            !url.searchParams.has("channel_group_id") ||
            item.channel_group_id === Number(url.searchParams.get("channel_group_id")),
        ),
      });
    }
    if (endpoint.startsWith("/channel-group-details/") && method === "DELETE") {
      this.members = this.members.filter((item) => item.id !== Number(endpoint.split("/").at(-1)));
      return Response.json({ status: "ok" });
    }
    throw new Error(`Unexpected fake Home endpoint ${endpoint}`);
  };
  addFile(id: string, fileProvider = provider, extra: Row = {}) {
    this.files.set(id, { id, provider: fileProvider, ...extra });
  }
  addGroup(pool: string, id: number, ids: string[]) {
    this.groups.push({ id, channel_name: `signalbox-pool-${pool}` });
    for (const auth_id of ids)
      this.members.push({ id: this.members.length + 1, channel_group_id: id, auth_id });
  }
}
interface Options {
  pool?: string;
  owner?: boolean;
  token?: string;
  body?: unknown;
  raw?: string;
  method?: string;
  signal?: AbortSignal;
}
export async function fixture(audience: readonly string[] = []) {
  const home = new FakeHome();
  const storage = new MemoryStorage();
  const productEvents: [string, string][] = [];
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const deps = {
    signingKey,
    previousSigningKey: undefined as string | undefined,
    home: home.fetch,
    now: () => new Date(time),
    audience: async () => audience,
    onProductEvent: (event: string, accountId: string) => productEvents.push([event, accountId]),
  };
  let control = new PoolControl(storage, deps);
  const tokens = new Map<string, string>();
  async function request(path: string, options: Options = {}): Promise<Request> {
    const pool = options.pool ?? "pool-a";
    if (!tokens.has(pool))
      tokens.set(
        pool,
        await signPoolToken(signingKey, { pool, owner: "fake-owner", organization: "fake-org" }),
      );
    return new Request(`https://pool.example/pool/v1${path}`, {
      method:
        options.method ??
        (options.body !== undefined || options.raw !== undefined ? "POST" : "GET"),
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${options.token ?? tokens.get(pool)}`,
        "x-signalbox-caller": options.owner === false ? "fake-member" : "fake-owner",
      },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  }
  async function call(path: string, options: Options = {}) {
    const response = await control.handle(await request(path, options));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Type")!, /application\/json/);
    return response;
  }
  async function acquire(action: string, input: Row = {}, operation = "native-operation") {
    const envelope = await signEnvelope(signingKey, accountAcquisitionPrefix, {
      owner: "organization:fake-org",
      provider,
      operation,
      action,
      at: time,
      expiresAt: time + 30_000,
      ...input,
    });
    return control.acquire(
      new Request(`https://pool.example${accountAcquisitionPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope }),
      }),
    );
  }
  return {
    home,
    storage,
    deps,
    productEvents,
    request,
    call,
    acquire,
    advance: (ms: number) => {
      time += ms;
    },
    expire: () => control.expire(),
    restart: () => {
      control = new PoolControl(storage, deps);
    },
  };
}
export async function error(response: Response, code: string, status = 400) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(((await response.json()) as Row).error, code);
}
