import { brand } from "../../brand.ts";
import type { Computer } from "../../apps/pool/ui/computer-types.ts";
import { callerHeader, isWeeklyCap, usageDays } from "../../apps/pool/contract.ts";
import { isMemberId, maxMembers, type PoolUsage } from "./pool-usage.ts";
import { ComputerHome, digest } from "./computer-home.ts";
import { boundPools, publicView, type ComputerStorage, type Registry, type StoredComputer } from "./computer-registry.ts";
export type { ComputerStorage } from "./computer-registry.ts";
import { PoolDirectory } from "./directory.ts";
import { readAccess } from "./access.ts";
import { fail, failureResponse, json, object, text } from "./json.ts";
import { openEnvelope, verifyPoolToken } from "./token.ts";
import { computerName, readIntent, seal, setupInstructions, setupTtl, signIntent, unseal, type SetupIntent } from "./setup-links.ts";
import { emitProductEvent, type ProductEventCallback } from "../setup/product-events.ts";
import { markSetupCompleted, observePendingUsage, type UsageObservationEvent } from "./usage-observation.ts";

interface Dependencies {
  storage: ComputerStorage; home: ComputerHome; signingKey: string; previousSigningKey?: string;
  origin?: string; now?: () => number; onProductEvent?: ProductEventCallback; usage?: Pick<PoolUsage, "summary" | "setCap">;
}
const storageKey = "computer-registry-v1";
/** One of the pools this person can use, or a refusal. */
function choosePool(pools: readonly { id: string }[], value: unknown): string {
  if (typeof value !== "string" || !pools.some((pool) => pool.id === value))
    return fail(403, "unauthorized", "This pool is not available to you.");
  return value;
}
/** Separate from subscription attribution. Computer setup and access changes share this queue. */
export class Computers {
  private deps: Dependencies;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Dependencies) { this.deps = deps; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private origin() { return this.deps.origin ?? `https://${brand.host}`; }
  private async run<T>(work: (registry: Registry) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const registry = await this.deps.storage.get<Registry>(storageKey) ?? {};
      let migrated = false;
      for (const computer of Object.values(registry)) {
        if (!computer.switchingTo) continue;
        computer.switching = [...new Set([...(computer.switching ?? []), computer.switchingTo])];
        delete computer.switchingTo;
        migrated = true;
      }
      if (migrated) await this.save(registry);
      return work(registry);
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private save(registry: Registry) { return this.deps.storage.put(storageKey, registry); }
  async expire(): Promise<void> {
    await this.run(async (registry) => {
      let changed = false;
      for (const computer of Object.values(registry)) {
        if (computer.link && computer.link.expiresAt <= this.now()) { delete computer.link; changed = true; }
      }
      if (changed) await this.save(registry);
      const directory = await PoolDirectory.load(this.deps.storage, this.now());
      await directory.prune(this.now());
      await directory.provisionPending(this.deps.home);
    });
  }
  private own(registry: Registry, user: string, id: unknown): StoredComputer {
    const computer = typeof id === "string" && Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (!computer || computer.user !== user) return fail(404, "not_found", "This computer does not exist.");
    return computer;
  }
  async context(request: Request): Promise<Response> {
    try {
      const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const claims = token ? await verifyPoolToken(this.deps.signingKey, token, this.deps.previousSigningKey) : undefined;
      const user = text(request.headers.get(callerHeader));
      if (!claims || !user) return fail(401, "unauthorized", "A signed-in pool caller is required.");
      if (request.method !== "GET") return fail(404, "not_found", "This setup endpoint does not exist.");
      return await this.run(async (registry) => {
        const directory = await PoolDirectory.load(this.deps.storage, this.now());
        const value = { ...claims, user, expiresAt: this.now() + setupTtl };
        this.check(directory, registry, value);
        const owner = claims.owner === user;
        if (owner) await directory.learn(claims, user);
        const intent = await signIntent(this.deps.signingKey, value);
        const computers = await this.listLocked(registry, user, owner ? undefined : claims.pool);
        const pools = directory.choices(user, value.expiresAt - setupTtl, claims)
          .filter((pool) => owner || pool.id === claims.pool);
        return json({ intent, href: `${this.origin()}/setup#intent=${encodeURIComponent(intent)}`, computers, pools,
          ...(claims.owner === user ? { shareHref: `${this.origin()}/share#intent=${intent}` } : {}),
          undoPrompt: `Undo ${brand.name} setup on this computer. Download ${this.origin()}/setup/client.mjs to a private temporary file, run it with Node.js 18 or newer and --undo, then delete it. Restore the backups and preserve later unrelated edits. Revocation is separate in your pool.` });
      });
    } catch (error) { return failureResponse(error); }
  }
  private check(directory: PoolDirectory, registry: Registry, intent: SetupIntent) {
    directory.check(intent);
    if (Object.values(registry).some((computer) => boundPools(computer).includes(intent.pool)
      && computer.user === intent.user && computer.removalPending))
      return fail(503, "backend_unavailable", "Removing access from this computer didn't finish. Ask the owner to retry, or try again later.");
  }
  /** The host's use audience. Native management roles do not add use access. */
  async audience(pool: string): Promise<string[]> {
    return this.run(async () => {
      const entry = (await PoolDirectory.load(this.deps.storage, this.now())).entry(pool);
      return entry ? [...new Set(entry.authorization === "executor-app-v1" ? entry.users : [entry.owner, ...entry.users])] : [];
    });
  }
  async permissions(pool: string, user: string) {
    return this.run(async () => (await PoolDirectory.load(this.deps.storage, this.now())).permissions(pool, user));
  }
  async access(request: Request): Promise<Response> {
    try {
      const change = await readAccess(request, this.deps.signingKey, this.deps.previousSigningKey, this.now());
      return await this.run(async (registry) => {
        const directory = await PoolDirectory.load(this.deps.storage, this.now());
        return json(await directory.apply(change, registry, this.deps.home, this.now(), () => this.save(registry)));
      });
    } catch (error) { return failureResponse(error); }
  }
  private async listLocked(registry: Registry, user: string, pool?: string): Promise<Computer[]> {
    const computers = Object.values(registry).filter((row) => row.user === user && (pool === undefined || boundPools(row).includes(pool)));
    for (const computer of computers) {
      if (computer.link && computer.link.expiresAt <= this.now()) delete computer.link;
    }
    const events = await observePendingUsage(registry,
      (targetPool, keyId, since) => this.deps.home.observed(targetPool, keyId, since),
      () => this.now(), { user, pool });
    await this.save(registry);
    this.emitUsageEvents(events);
    return computers.map(publicView).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async list(user: string, _pool?: string): Promise<Computer[]> {
    return this.run((registry) => this.listLocked(registry, user));
  }
  /** Reconcile only pending computers against Home's successful, exact-key usage records. */
  async observeUsage(): Promise<void> {
    await this.run(async (registry) => {
      const events = await observePendingUsage(registry,
        (pool, keyId, since) => this.deps.home.observed(pool, keyId, since),
        () => this.now());
      await this.save(registry);
      this.emitUsageEvents(events);
    });
  }
  private emitUsageEvents(events: UsageObservationEvent[]): void {
    for (const event of events) emitProductEvent(this.deps.onProductEvent, event.event, event.accountId);
  }
  async handle(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") return fail(404, "not_found", "This setup endpoint does not exist.");
      const raw = await request.text();
      if (raw.length > 64_000) return fail(400, "invalid_session", "Setup request is too large.");
      const body: unknown = JSON.parse(raw);
      const payload = object(body) && typeof body.envelope === "string"
        ? await openEnvelope(this.deps.signingKey, "sbs1", body.envelope, this.deps.previousSigningKey) : undefined;
      const action = new URL(request.url).pathname.split("/").at(-1);
      if (!object(payload) || payload.action !== action || typeof payload.expiresAt !== "number"
        || payload.expiresAt <= this.now() || payload.expiresAt > this.now() + 30_000)
        return fail(401, "unauthorized", "A valid setup host assertion is required.");
      if (action === "claim") return await this.claim(payload.token, payload.format);
      if (action === "observed") return await this.observe(payload.tokenHash);
      const user = text(payload.user);
      if (!user) return fail(401, "unauthorized", "Sign in before setting up a computer.");
      const intent = await readIntent(this.deps.signingKey, payload.intent, user, this.now(), this.deps.previousSigningKey);
      if (action === "usage" || action === "cap") return await this.ownerUsage(action, intent, user, payload);
      return await this.run(async (registry) => {
        const directory = await PoolDirectory.load(this.deps.storage, this.now());
        if (action !== "revoked") {
          this.check(directory, registry, intent);
          await directory.learn(intent, user);
        }
        if (action === "computers" || action === "switch" || action === "links" || action === "validate")
          await directory.learnOwn(payload.own, user, this.now());
        const pools = directory.choices(user, intent.expiresAt - setupTtl, intent);
        switch (action) {
          case "validate": return json({ pool: intent.pool, organization: intent.organization, owner: intent.owner, name: directory.entry(intent.pool)?.name ?? "" });
          case "computers": return json({ computers: await this.listLocked(registry, user), pools });
          case "links": {
            // A link may name any pool this person can use; it defaults to the intent's own pool.
            const pool = choosePool(pools, payload.pool === undefined ? intent.pool : payload.pool);
            if (pool !== intent.pool) this.check(directory, registry, { ...intent, pool });
            return this.create(registry, { ...intent, pool, owner: directory.entry(pool)?.owner ?? intent.owner }, payload);
          }
          case "rename": {
            const computer = this.own(registry, user, payload.id);
            const name = computerName(payload.name);
            if (!name) return fail(400, "invalid_session", "Name this computer using 1 to 60 characters.");
            computer.name = name;
            await this.save(registry);
            return json(publicView(computer));
          }
          case "refresh": {
            const computer = this.own(registry, user, payload.id);
            this.check(directory, registry, { ...intent, pool: computer.pool });
            return this.refresh(registry, user, payload.id);
          }
          case "revoke": return this.revoke(registry, user, payload.id);
          case "revoked": {
            const computer = this.own(registry, user, payload.id);
            if (computer.state !== "revoking" && computer.state !== "revoked" && computer.state !== "removed") return fail(409, "busy", "Revoke the model key first.");
            computer.state = "revoked"; computer.revokedAt ??= new Date(this.now()).toISOString();
            await this.save(registry);
            return json(null);
          }
          case "switch": {
            const computer = this.own(registry, user, payload.id);
            const target = choosePool(pools, payload.pool);
            for (const pool of new Set([...boundPools(computer), target]))
              this.check(directory, registry, { ...intent, pool });
            return this.switchPool(registry, computer, target, directory.entry(target)?.owner);
          }
          default: return fail(404, "not_found", "This setup endpoint does not exist.");
        }
      });
    } catch (error) { return failureResponse(error); }
  }
  /** The share host checked the owner's browser session; the signed intent must agree. Home I/O runs outside the queue. */
  private async ownerUsage(action: "usage" | "cap", intent: SetupIntent, user: string, payload: Record<string, unknown>): Promise<Response> {
    const usage = this.deps.usage;
    if (!usage) return fail(404, "not_found", "This setup endpoint does not exist.");
    await this.run(async (registry) => {
      const directory = await PoolDirectory.load(this.deps.storage, this.now());
      this.check(directory, registry, intent);
      const canManage = directory.permissions(intent.pool, user)?.canManage ?? intent.owner === user;
      if (!canManage) return fail(403, "unauthorized", "Only a pool manager can see each person's usage or set caps.");
    });
    if (action === "cap") {
      if (payload.weekly !== null && !isWeeklyCap(payload.weekly)) return fail(400, "invalid_query", "Enter a weekly cap between $0.01 and $100,000, in whole cents.");
      await usage.setCap(intent.pool, intent.owner, String(payload.member ?? ""), payload.weekly);
      return json(null);
    }
    const members = Array.isArray(payload.members) ? payload.members.filter(isMemberId).slice(0, maxMembers) : [];
    return json(await usage.summary(intent.pool, intent.owner, user, usageDays, members, true));
  }
  private async create(registry: Registry, intent: SetupIntent, input: Record<string, unknown>): Promise<Response> {
    const name = computerName(input.name);
    // Without a tools pair the computer gets models only; its tools connect through the MCP guide.
    const tools = input.toolsKeyId !== undefined || input.toolsToken !== undefined;
    if (!name) return fail(400, "invalid_session", "Name this computer using 1 to 60 characters.");
    if (tools && (!text(input.toolsKeyId) || !text(input.toolsToken)))
      return fail(400, "invalid_session", "The tools token for this computer is incomplete.");
    const computer: StoredComputer = {
      id: crypto.randomUUID(), name, user: intent.user, pool: intent.pool,
      createdAt: new Date(this.now()).toISOString(), boundAt: new Date(this.now()).toISOString(), state: "issuing",
      ...tools && { toolsKeyId: input.toolsKeyId as string, toolsHash: await digest(input.toolsToken as string) },
      firstModelRequestAt: null, firstToolCallAt: null, revokedAt: null, removedAt: null,
    };
    registry[computer.id] = computer;
    await this.save(registry);
    const issued = await this.deps.home.mint(computer.user, computer.pool, computer.id, intent.owner);
    computer.keyId = issued.keyId; computer.userId = issued.userId;
    // Store the acknowledged id before any fallible encryption or response work.
    await this.save(registry);
    const { token, link } = await seal(this.deps.signingKey, {
      modelUrl: this.origin(), modelKey: issued.key,
      ...tools && { toolsUrl: `${this.origin()}/mcp`, toolsToken: input.toolsToken as string },
    }, this.now());
    computer.link = link;
    await this.save(registry);
    return json({ computer: publicView(computer), token, expiresAt: new Date(link.expiresAt).toISOString() });
  }
  private async refresh(registry: Registry, user: string, id: unknown): Promise<Response> {
    const computer = this.own(registry, user, id);
    if (computer.state !== "issuing" || !computer.link || computer.link.expiresAt <= this.now())
      return fail(409, "busy", "This link is used or expired. Revoke this computer, then start a new setup.");
    const credentials = await unseal(this.deps.signingKey, computer.link, this.deps.previousSigningKey);
    const { token, link } = await seal(this.deps.signingKey, credentials, this.now());
    computer.link = link;
    await this.save(registry);
    return json({ computer: publicView(computer), token, expiresAt: new Date(link.expiresAt).toISOString() });
  }
  private async revoke(registry: Registry, user: string, id: unknown): Promise<Response> {
    const computer = this.own(registry, user, id);
    computer.state = computer.state === "revoked" ? "revoked" : "revoking";
    delete computer.link;
    await this.save(registry);
    const keys = computer.keyId ? [computer.keyId] : await this.deps.home.find(computer.id);
    for (const key of keys) await this.deps.home.revoke(key);
    return json({ toolsKeyId: computer.toolsKeyId ?? null });
  }
  private async switchPool(registry: Registry, computer: StoredComputer, pool: string, owner?: string): Promise<Response> {
    if (computer.state !== "active" || computer.removalPending || !computer.keyId) return fail(409, "busy", "This computer cannot switch pools.");
    if (computer.pool === pool && !computer.switching?.length) return json(publicView(computer));
    computer.switching = [...new Set([...(computer.switching ?? []), pool])];
    await this.save(registry);
    // Only the pool's owner is credited if this re-point happens to create its group.
    computer.userId = await this.deps.home.rebind(computer.keyId, pool, computer.user, owner);
    computer.firstModelRequestEverAt ??= computer.firstModelRequestAt;
    computer.pool = pool; computer.boundAt = new Date(this.now()).toISOString();
    delete computer.switching;
    computer.firstModelRequestAt = null;
    delete computer.modelObservationCheckedAt;
    await this.save(registry);
    return json(publicView(computer));
  }
  private claim(token: unknown, format: unknown): Promise<Response> {
    return this.run(async (registry) => {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return fail(410, "invalid_session", "This setup link has expired or was already used.");
      const hash = await digest(token);
      const computer = Object.values(registry).find((computer) => computer.state === "issuing" && !computer.removalPending && computer.link?.hash === hash);
      if (!computer?.link || computer.link.expiresAt <= this.now()) return fail(410, "invalid_session", "This setup link has expired or was already used.");
      const credentials = await unseal(this.deps.signingKey, computer.link, this.deps.previousSigningKey);
      delete computer.link;
      computer.state = "active";
      await this.save(registry); // Consumption is durable before sending either secret.
      const value = { version: 1, brand, credentials, instructions: setupInstructions(this.origin()) };
      if (format === "json") return json(value);
      const document = `${value.instructions}\nThis link is now consumed. Save the JSON below in a private temporary file and run the installer with --payload-file <file>, then delete the file. Do not fetch the link again.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
      return new Response(document, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" } });
    });
  }
  private observe(tokenHash: unknown): Promise<Response> {
    return this.run(async (registry) => {
      if (typeof tokenHash !== "string") return fail(400, "invalid_session", "A token digest is required.");
      const computer = Object.values(registry).find((computer) => computer.state === "active" && computer.toolsHash === tokenHash);
      let completed = false;
      if (computer && !computer.firstToolCallAt) {
        computer.firstToolCallAt = new Date(this.now()).toISOString();
        completed = markSetupCompleted(computer, () => this.now());
        await this.save(registry);
      }
      if (completed && computer) emitProductEvent(this.deps.onProductEvent, "setup_completed", computer.user);
      return json(null);
    });
  }
}
