import { brand } from "../../brand.ts";
import type { Computer } from "../../apps/pool/ui/computer-types.ts";
import { callerHeader } from "../../apps/pool/contract.ts";
import { ComputerHome, digest } from "./computer-home.ts";
import { fail, failureResponse, json, object, text } from "./json.ts";
import { openEnvelope, verifyPoolToken } from "./token.ts";
import { readIntent, seal, setupInstructions, setupTtl, signIntent, unseal, type SealedLink, type SetupIntent } from "./setup-links.ts";

interface StoredComputer {
  id: string; name: string; user: string; pool: string; createdAt: string; boundAt: string;
  state: "issuing" | "active" | "revoking" | "revoked";
  keyId?: number; userId?: number; toolsKeyId: string; toolsHash: string;
  firstModelRequestAt: string | null; firstToolCallAt: string | null; revokedAt: string | null;
  link?: SealedLink;
}
export interface ComputerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
interface Dependencies {
  storage: ComputerStorage; home: ComputerHome; signingKey: string; previousSigningKey?: string;
  origin?: string; now?: () => number;
}
const storageKey = "computer-registry-v1";
type Registry = Record<string, StoredComputer>;
const publicView = (computer: StoredComputer): Computer => ({
  id: computer.id, name: computer.name, poolId: computer.pool, createdAt: computer.createdAt,
  state: computer.state, firstModelRequestAt: computer.firstModelRequestAt,
  firstToolCallAt: computer.firstToolCallAt, revokedAt: computer.revokedAt,
});

/** Separate from subscription attribution. Only computer operations share this queue. */
export class Computers {
  private deps: Dependencies;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Dependencies) { this.deps = deps; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private origin() { return this.deps.origin ?? `https://${brand.host}`; }
  private async run<T>(work: (registry: Registry) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const registry = await this.deps.storage.get<Registry>(storageKey) ?? {};
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
      const intent = await signIntent(this.deps.signingKey, { ...claims, user, expiresAt: this.now() + setupTtl });
      if (request.method !== "GET") return fail(404, "not_found", "This setup endpoint does not exist.");
      const computers = await this.list(user, claims.pool);
      return json({ intent, href: `${this.origin()}/setup#intent=${encodeURIComponent(intent)}`, computers,
        undoPrompt: `Undo ${brand.name} setup on this computer. Download ${this.origin()}/setup/client.mjs to a private temporary file, run it with Node.js 18 or newer and --undo, then delete it. Restore the backups and preserve later unrelated edits. Revocation is separate in your pool.` });
    } catch (error) { return failureResponse(error); }
  }
  async list(user: string, pool: string): Promise<Computer[]> {
    return this.run(async (registry) => {
      const computers = Object.values(registry).filter((row) => row.user === user && row.pool === pool);
      for (const computer of computers) {
        if (computer.link && computer.link.expiresAt <= this.now()) delete computer.link;
        if (computer.state === "active" && !computer.firstModelRequestAt && computer.keyId)
          computer.firstModelRequestAt = await this.deps.home.observed(pool, computer.keyId, computer.boundAt);
      }
      await this.save(registry);
      return computers.map(publicView).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
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
      if (action === "validate") return json({ pool: intent.pool, organization: intent.organization });
      if (action === "computers") return json({ computers: await this.list(user, intent.pool) });
      return await this.run(async (registry) => {
        switch (action) {
          case "links": return this.create(registry, intent, payload);
          case "refresh": return this.refresh(registry, user, payload.id);
          case "revoke": return this.revoke(registry, user, payload.id);
          case "revoked": {
            const computer = this.own(registry, user, payload.id);
            if (computer.state !== "revoking" && computer.state !== "revoked") return fail(409, "busy", "Revoke the model key first.");
            computer.state = "revoked"; computer.revokedAt ??= new Date(this.now()).toISOString();
            await this.save(registry);
            return json(null);
          }
          case "rebind": return this.rebind(registry, user, payload.id, intent);
          default: return fail(404, "not_found", "This setup endpoint does not exist.");
        }
      });
    } catch (error) { return failureResponse(error); }
  }
  private async create(registry: Registry, intent: SetupIntent, input: Record<string, unknown>): Promise<Response> {
    const name = text(input.name)?.trim();
    if (!name || name.length > 60 || /[\u0000-\u001f]/.test(name) || !text(input.toolsKeyId) || !text(input.toolsToken))
      return fail(400, "invalid_session", "Name this computer using 1 to 60 characters.");
    const computer: StoredComputer = {
      id: crypto.randomUUID(), name, user: intent.user, pool: intent.pool,
      createdAt: new Date(this.now()).toISOString(), boundAt: new Date(this.now()).toISOString(),
      state: "issuing", toolsKeyId: input.toolsKeyId as string, toolsHash: await digest(input.toolsToken as string),
      firstModelRequestAt: null, firstToolCallAt: null, revokedAt: null,
    };
    registry[computer.id] = computer;
    await this.save(registry);
    const issued = await this.deps.home.mint(computer.user, computer.pool, computer.id);
    computer.keyId = issued.keyId; computer.userId = issued.userId;
    // Store the acknowledged id before any fallible encryption or response work.
    await this.save(registry);
    const { token, link } = await seal(this.deps.signingKey, {
      modelUrl: this.origin(), modelKey: issued.key, toolsUrl: `${this.origin()}/mcp`, toolsToken: input.toolsToken as string,
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
    return json({ toolsKeyId: computer.toolsKeyId });
  }
  private async rebind(registry: Registry, user: string, id: unknown, intent: SetupIntent): Promise<Response> {
    const computer = this.own(registry, user, id);
    if (computer.state !== "active" || !computer.keyId) return fail(409, "busy", "This computer cannot switch pools.");
    await this.deps.home.rebind(computer.keyId, intent.pool);
    computer.pool = intent.pool; computer.boundAt = new Date(this.now()).toISOString();
    computer.firstModelRequestAt = null;
    await this.save(registry);
    return json(publicView(computer));
  }
  private claim(token: unknown, format: unknown): Promise<Response> {
    return this.run(async (registry) => {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return fail(410, "invalid_session", "This setup link has expired or was already used.");
      const hash = await digest(token);
      const computer = Object.values(registry).find((computer) => computer.state === "issuing" && computer.link?.hash === hash);
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
      if (computer && !computer.firstToolCallAt) {
        computer.firstToolCallAt = new Date(this.now()).toISOString();
        await this.save(registry);
      }
      return json(null);
    });
  }
}
