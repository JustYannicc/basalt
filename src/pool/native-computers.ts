import { modelDrainProtocol } from "./model-drain-contract.ts";
import type { ComputerHome } from "./computer-home.ts";
import {
  publicView,
  type ComputerStorage,
  type Registry,
  type StoredComputer,
} from "./computer-registry.ts";
import { PoolDirectory } from "./directory.ts";
import {
  BackendFailure,
  ControlFailure,
  fail,
  failureResponse,
  HomeTransportFailure,
  json,
  object,
  text,
} from "./json.ts";
import { openNativeKey, sealNativeKey } from "./native-key.ts";
import { NativeStreams } from "./native-streams.ts";
import { nativePoolDisplay } from "./native-display.ts";
import { signedTeams } from "./team-labels.ts";
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
/** A model device approved before its key could be minted. */
class KeyRequest {
  readonly computer: string;
  readonly user: string;
  readonly pool: string;
  readonly owner: string;
  readonly identity: string;
  constructor(computer: StoredComputer, owner: string) {
    this.computer = computer.id;
    this.user = computer.user;
    this.pool = computer.pool;
    this.owner = owner;
    this.identity = keyIdentity(computer);
  }
}
const modelsUnavailable = () =>
  fail(503, "backend_unavailable", "Models are unavailable right now. Try again shortly.", 2);
/**
 * The Home keys revoking this computer removes. A tools-only device never has one, so a stopped
 * container cannot hold up its revocation. A model device whose key was never recorded may hold
 * one from a lost mint reply; looking for it is best-effort, and a mint still running revokes its
 * own key once it sees the device revoked.
 */
export async function revocableKeys(computer: StoredComputer, home: ComputerHome) {
  if (computer.keyId) return [computer.keyId];
  if (!computer.native) return home.find(computer.id);
  if (!computer.native.models) return [];
  return home.find(computer.id).catch((error: unknown) => {
    console.error(
      "Native revocation could not look for an unrecorded model key",
      mintFailure(error),
    );
    return [];
  });
}
const mintFailure = (error: unknown) =>
  error instanceof HomeTransportFailure
    ? error.errorClass
    : error instanceof BackendFailure
      ? `backend ${error.backendStatus}`
      : error instanceof ControlFailure
        ? error.code
        : "unknown";

/** Native devices share the existing computer registry, key lifecycle and access-removal queue. */
export class NativeComputers {
  abortPool(pool: string) {
    this.streams.abortPool(pool);
  }
  private streams = new NativeStreams();
  private minting = new Map<string, Promise<void>>();
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
    return (await this.admitted(registry, caller)).computer;
  }
  /** A model device whose key is not minted yet stays connected; its tools need no key. */
  private async admitted(registry: Registry, caller: Identity) {
    const row = Object.hasOwn(registry, caller.computer) ? registry[caller.computer] : undefined;
    if (
      !row ||
      row.user !== caller.user ||
      row.pool !== caller.pool ||
      row.native?.grant !== caller.grant ||
      row.state !== "active" ||
      row.removalPending
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
    return { computer: row, owner: pool.owner };
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
          const computer = await this.active(registry, caller);
          if (value.display !== true) return json({ active: true });
          const display = await nativePoolDisplay(
            this.deps.storage,
            computer,
            this.deps.now(),
            signedTeams(value.teams),
          );
          return json({ active: true, display });
        }
        if (value.action === "learn") {
          if (this.learn(registry, caller.user, value)) await this.deps.save(registry);
          return json({ learned: true });
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
        for (const id of await revocableKeys(computer, this.deps.home))
          await this.deps.home.revoke(id);
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
      // The model key is minted on first model use, so a stopped container cannot fail approval.
      const computer: StoredComputer = {
        id: crypto.randomUUID(),
        name,
        user,
        pool,
        state: "active",
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
      return reply(computer);
    });
  }
  /**
   * Lists a tools-only device the tools service approved without this pool, for Connect's list and
   * its revoke. Its grant alone authorizes it, so nothing here is checked against the directory. A
   * grant's row is never recreated, replaced or reactivated. True when a row was added.
   */
  learn(registry: Registry, user: string, device: Record<string, unknown>) {
    const grant = text(device.grant),
      computer = text(device.computer),
      pool = text(device.pool),
      toolsOrganization = text(device.toolsOrganization);
    if (
      !grant?.startsWith("native:") ||
      !computer ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(computer) ||
      !pool ||
      !toolsOrganization ||
      Object.hasOwn(registry, computer) ||
      Object.values(registry).some((row) => row.native?.grant === grant)
    )
      return false;
    const at = new Date(this.deps.now()).toISOString();
    registry[computer] = {
      id: computer,
      // Connect's list names it before anyone renames it, when the tools service sent no name.
      name: computerName(device.name) ?? "Tools-only device",
      user,
      pool,
      state: "active",
      createdAt: at,
      boundAt: at,
      firstModelRequestAt: null,
      firstToolCallAt: null,
      revokedAt: null,
      native: { grant, models: false, toolsOrganization },
    };
    return true;
  }
  /** One mint per computer at a time; every waiting model request shares its outcome. */
  private provision(request: KeyRequest): Promise<void> {
    const running = this.minting.get(request.computer);
    if (running) return running;
    const work = this.mint(request).finally(() => this.minting.delete(request.computer));
    this.minting.set(request.computer, work);
    return work;
  }
  /** Home is called outside the registry queue, so a slow container holds up no other device. */
  private async mint(request: KeyRequest) {
    // Re-read under the queue: a request made before an earlier mint was stored needs nothing.
    if (!(await this.deps.run(async (registry) => this.keyless(registry, request)))) return;
    // A lost Home reply, failed save or replaced object leaves keys nobody holds.
    for (const id of await this.deps.home.find(request.computer)) await this.deps.home.revoke(id);
    const issued = await this.deps.home.mint(
      request.user,
      request.pool,
      request.computer,
      request.owner,
    );
    const key = await sealNativeKey(this.deps.signingKey, issued.key, request.identity);
    const kept = await this.deps.run(async (registry) => {
      const computer = this.keyless(registry, request);
      if (!computer) return false;
      computer.keyId = issued.keyId;
      computer.userId = issued.userId;
      computer.native!.key = key;
      await this.deps.save(registry);
      return true;
    });
    // Revoked or removed while Home was minting: nobody may keep this key.
    if (!kept) await this.deps.home.revoke(issued.keyId);
  }
  private keyless(registry: Registry, request: KeyRequest) {
    const computer = Object.hasOwn(registry, request.computer)
      ? registry[request.computer]
      : undefined;
    return computer?.state === "active" &&
      !computer.removalPending &&
      computer.native?.models &&
      !computer.native.key &&
      keyIdentity(computer) === request.identity
      ? computer
      : undefined;
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
    const first = await this.forward(request, url, value, caller);
    if (!(first instanceof KeyRequest)) return first;
    await this.provision(first).catch((error: unknown) => {
      console.error("Native model key could not be minted", mintFailure(error));
    });
    const second = await this.forward(request, url, value, caller);
    return second instanceof KeyRequest ? modelsUnavailable() : second;
  }
  private forward(request: Request, url: URL, value: Record<string, unknown>, caller: Identity) {
    return this.deps.run(async (registry) => {
      const { computer, owner } = await this.admitted(registry, caller);
      if (!computer.native?.models)
        return fail(403, "unauthorized", "This device was approved for tools only.");
      if (!computer.native.key) return new KeyRequest(computer, owner);
      const key = await openNativeKey(
        this.deps.signingKey,
        computer.native.key,
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
      if (
        value.modelDrain === modelDrainProtocol &&
        request.method === "GET" &&
        url.pathname === "/v1/responses"
      )
        headers.set("sec-websocket-protocol", modelDrainProtocol);
      else if (headers.get("sec-websocket-protocol") === modelDrainProtocol)
        headers.delete("sec-websocket-protocol");
      url.searchParams.delete("key");
      url.searchParams.delete("auth_token");
      return {
        ...lease,
        pool: computer.pool,
        person: computer.user,
        keyId: computer.keyId,
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
