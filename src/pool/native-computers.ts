import type { ComputerHome } from "./computer-home.ts";
import {
  publicView,
  type ComputerStorage,
  type Registry,
  type StoredComputer,
} from "./computer-registry.ts";
import { PoolDirectory } from "./directory.ts";
import { fail, failureResponse, json, object, text } from "./json.ts";
import { openNativeKey, sealNativeKey } from "./native-key.ts";
import { NativeStreams } from "./native-streams.ts";
import { computerName, readIntent, setupTtl } from "./setup-links.ts";
import { openEnvelope } from "./token.ts";
import {
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
  nativeSessionHeader,
} from "./native-contract.ts";

interface Dependencies {
  storage: ComputerStorage;
  home: ComputerHome;
  signingKey: string;
  previousSigningKey?: string;
  now: () => number;
  run: <A>(work: (registry: Registry) => Promise<A>) => Promise<A>;
  save: (registry: Registry) => Promise<unknown>;
}
interface Identity {
  user: string;
  grant: string;
  computer: string;
  pool: string;
}
const identity = (value: Record<string, unknown>): Identity => {
  const user = text(value.user),
    grant = text(value.grant),
    computer = text(value.computer),
    pool = text(value.pool);
  if (!user || !grant?.startsWith("native:") || !computer || !pool)
    return fail(401, "unauthorized", "A native device grant is required.");
  return { user, grant, computer, pool };
};
const keyIdentity = (computer: StoredComputer) =>
  JSON.stringify([computer.id, computer.native?.grant, computer.pool, computer.user]);

/** Native devices share the existing computer registry, key lifecycle and access-removal queue. */
export class NativeComputers {
  private streams = new NativeStreams();
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  sync(registry: Registry) {
    this.streams.sync(registry);
  }
  private async assertion(envelope: unknown, prefix: string) {
    const value =
      typeof envelope === "string"
        ? await openEnvelope(this.deps.signingKey, prefix, envelope, this.deps.previousSigningKey)
        : undefined;
    const now = this.deps.now();
    if (
      !object(value) ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + 30_000
    )
      return fail(401, "unauthorized", "A current native host assertion is required.");
    return value;
  }
  private async active(registry: Registry, caller: Identity) {
    const row = Object.hasOwn(registry, caller.computer) ? registry[caller.computer] : undefined;
    if (
      !row ||
      row.user !== caller.user ||
      row.pool !== caller.pool ||
      row.native?.grant !== caller.grant ||
      row.state !== "active" ||
      row.removalPending ||
      (row.native.models && !row.native.key)
    )
      return fail(401, "unauthorized", "This device is no longer connected.");
    const directory = await PoolDirectory.load(this.deps.storage, this.deps.now());
    const pool = directory.entry(row.pool);
    if (
      !pool ||
      !pool.users.includes(row.user) ||
      !directory.allowed(row.pool, row.user, Date.parse(row.createdAt))
    )
      return fail(403, "unauthorized", "This pool is no longer available to this device.");
    return row;
  }
  async control(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST")
        return fail(404, "not_found", "This native endpoint does not exist.");
      const raw = await request.text();
      if (raw.length > 64_000)
        return fail(400, "invalid_session", "Native authorization is too large.");
      const body: unknown = JSON.parse(raw);
      const value = await this.assertion(
        object(body) ? body.envelope : undefined,
        nativeControlPrefix,
      );
      if (value.action === "register") return await this.register(value);
      const caller = identity(value);
      return await this.deps.run(async (registry) => {
        if (value.action === "check") {
          await this.active(registry, caller);
          return json({ active: true });
        }
        if (value.action !== "revoke")
          return fail(404, "not_found", "This native endpoint does not exist.");
        const computer = Object.hasOwn(registry, caller.computer)
          ? registry[caller.computer]
          : undefined;
        if (!computer || computer.user !== caller.user || computer.native?.grant !== caller.grant)
          return fail(404, "not_found", "This native device does not exist.");
        computer.state = "revoking";
        delete computer.link;
        await this.deps.save(registry);
        // The saved state stops requests and active streams before Home cleanup can fail.
        const keys = computer.keyId ? [computer.keyId] : await this.deps.home.find(computer.id);
        for (const id of keys) await this.deps.home.revoke(id);
        delete computer.native.key;
        computer.state = "revoked";
        computer.revokedAt ??= new Date(this.deps.now()).toISOString();
        await this.deps.save(registry);
        return json({ revoked: true });
      });
    } catch (error) {
      return failureResponse(error);
    }
  }
  private async register(input: Record<string, unknown>) {
    const user = text(input.user),
      grant = text(input.grant),
      name = computerName(input.name);
    if (
      !user ||
      !grant?.startsWith("native:") ||
      !name ||
      typeof input.tools !== "boolean" ||
      typeof input.models !== "boolean" ||
      (!input.models && !input.tools)
    )
      return fail(400, "invalid_session", "Choose a computer name and native access.");
    const models = input.models;
    const intent = await readIntent(
      this.deps.signingKey,
      input.intent,
      user,
      this.deps.now(),
      this.deps.previousSigningKey,
    );
    return this.deps.run(async (registry) => {
      const directory = await PoolDirectory.load(this.deps.storage, this.deps.now());
      directory.check(intent);
      const source = directory.entry(intent.pool);
      if (source && (source.organization !== intent.organization || source.owner !== intent.owner))
        return fail(403, "unauthorized", "The setup intent belongs to another pool organization.");
      await directory.learn(intent, user);
      const choices = directory.choices(user, intent.expiresAt - setupTtl, intent);
      const pool = input.pool === undefined ? intent.pool : input.pool;
      if (typeof pool !== "string" || !choices.some((choice) => choice.id === pool))
        return fail(403, "unauthorized", "Choose an available pool.");
      if (input.tools && intent.owner !== user)
        return fail(403, "unauthorized", "Approve tools from your own Connect page.");
      const entry = directory.entry(pool);
      if (!entry) return fail(403, "unauthorized", "This pool is unavailable.");
      const toolsOrganization = input.tools ? intent.organization : undefined;
      const reply = (computer: StoredComputer) =>
        json({
          computer: publicView(computer),
          pool,
          models: computer.native!.models,
          ...(toolsOrganization === undefined ? {} : { toolsOrganization }),
        });
      const previous = Object.values(registry).find((computer) => computer.native?.grant === grant);
      if (previous) {
        if (
          previous.user !== user ||
          previous.pool !== pool ||
          previous.native?.toolsOrganization !== toolsOrganization ||
          previous.native?.models !== models
        )
          return fail(
            403,
            "unauthorized",
            "This native grant already belongs to another approval.",
          );
        await this.active(registry, { user, grant, pool, computer: previous.id });
        return reply(previous);
      }
      const at = new Date(this.deps.now()).toISOString();
      const computer: StoredComputer = {
        id: crypto.randomUUID(),
        name,
        user,
        pool,
        state: "issuing",
        createdAt: at,
        boundAt: at,
        firstModelRequestAt: null,
        firstToolCallAt: null,
        revokedAt: null,
        native: {
          grant,
          models,
          ...(toolsOrganization === undefined ? {} : { toolsOrganization }),
        },
      };
      registry[computer.id] = computer;
      await this.deps.save(registry);
      if (models) {
        const issued = await this.deps.home.mint(user, pool, computer.id, entry.owner);
        computer.keyId = issued.keyId;
        computer.userId = issued.userId;
        await this.deps.save(registry);
        computer.native!.key = await sealNativeKey(
          this.deps.signingKey,
          issued.key,
          keyIdentity(computer),
        );
      }
      computer.state = "active";
      await this.deps.save(registry);
      return reply(computer);
    });
  }
  async session(request: Request) {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return fail(404, "not_found", "This native endpoint does not exist.");
    const envelope = request.headers.get(nativeSessionHeader);
    if (!envelope || envelope.length > 16_384)
      return fail(401, "unauthorized", "A native session assertion is required.");
    const value = await this.assertion(envelope, nativeControlPrefix);
    if (value.action !== "session")
      return fail(401, "unauthorized", "A native session assertion is required.");
    const caller = identity(value);
    return this.deps.run(async (registry) => {
      const computer = await this.active(registry, caller);
      return this.streams.acquire(computer.id, computer.pool, request.signal);
    });
  }
  async model(request: Request) {
    const value = await this.assertion(request.headers.get(nativeModelHeader), nativeModelPrefix);
    const url = new URL(request.url);
    if (value.method !== request.method || value.path !== url.pathname + url.search)
      return fail(401, "unauthorized", "The native assertion belongs to another request.");
    const caller = identity(value);
    return this.deps.run(async (registry) => {
      const computer = await this.active(registry, caller);
      if (!computer.native?.models)
        return fail(403, "unauthorized", "This device was approved for tools only.");
      const key = await openNativeKey(
        this.deps.signingKey,
        computer.native!.key!,
        keyIdentity(computer),
        this.deps.previousSigningKey,
      );
      const lease = this.streams.acquire(computer.id, computer.pool, request.signal);
      const headers = new Headers(request.headers);
      for (const name of [
        nativeModelHeader,
        "cookie",
        "authorization",
        "x-api-key",
        "x-goog-api-key",
      ])
        headers.delete(name);
      headers.set("authorization", `Bearer ${key}`);
      url.searchParams.delete("key");
      url.searchParams.delete("auth_token");
      return {
        ...lease,
        request: new Request(url, {
          method: request.method,
          headers,
          signal: lease.signal,
          ...(request.body ? { body: request.body, duplex: "half" } : {}),
        }),
      };
    });
  }
}
