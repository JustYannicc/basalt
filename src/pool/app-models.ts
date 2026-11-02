import { appModelLabel, appModelPath, appModelPrefix } from "./app-model-contract.ts";
import type { ComputerHome } from "./computer-home.ts";
import type { ComputerStorage } from "./computer-registry.ts";
import { PoolDirectory } from "./directory.ts";
import { fail, failureResponse, object, text, readBody } from "./json.ts";
import { openEnvelope } from "./token.ts";

interface PendingKey { label: string; keyId?: number; expiresAt: number; assertionExpires: number; state: "pending" | "cleanup" | "closed" }
type Registry = Record<string, PendingKey>;
const registryKey = "app-model-key-custody-v1";
interface Dependencies {
  storage: ComputerStorage;
  home: Pick<ComputerHome, "mintAppModel" | "findAppModel" | "revoke">;
  signingKey: string;
  previousSigningKey?: string;
  now: () => number;
  schedule: (at: number) => Promise<unknown>;
  ready: () => Promise<boolean>;
  forward: (request: Request, identity: { pool: string; person: string; keyId: number; appId: string; requirement: string }) => Promise<Response>;
}
/** App model keys never leave this host. Durable cleanup survives a lost response or object restart. */
export class AppModels {
  private deps: Dependencies;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Set<string>();
  constructor(deps: Dependencies) { this.deps = deps; }
  private change<A>(work: (rows: Registry) => A | Promise<A>): Promise<A> {
    const next = this.tail.then(async () => {
      const rows = await this.deps.storage.get<Registry>(registryKey) ?? {};
      const result = await work(rows);
      await this.deps.storage.put(registryKey, rows);
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private async cleanup(nonce: string, row: PendingKey) {
    const keys = row.keyId ? [row.keyId] : await this.deps.home.findAppModel(row.label);
    for (const id of keys) await this.deps.home.revoke(id);
    await this.change((rows) => { if (rows[nonce]) rows[nonce].state = "closed"; });
  }
  async tick() {
    const rows = await this.deps.storage.get<Registry>(registryKey) ?? {};
    for (const [nonce, row] of Object.entries(rows)) {
      if (this.active.has(nonce)) continue;
      if (row.state !== "closed" && (row.state === "cleanup" || row.expiresAt <= this.deps.now()))
        await this.cleanup(nonce, row);
    }
    await this.change((current) => {
      for (const [nonce, row] of Object.entries(current))
        if (row.state === "closed" && row.assertionExpires <= this.deps.now()) delete current[nonce];
    });
  }
  async handle(request: Request): Promise<Response> {
    let nonce: string | undefined;
    try {
      if (request.method !== "POST" || new URL(request.url).pathname !== appModelPath)
        return fail(404, "not_found", "This model endpoint does not exist.");
      const raw = await readBody(request, 1_500_000);
      if (raw === undefined) return fail(400, "invalid_query", "The model request is too large.");
      const payload: unknown = JSON.parse(new TextDecoder().decode(raw));
      const value = object(payload) && typeof payload.envelope === "string"
        ? await openEnvelope(this.deps.signingKey, appModelPrefix, payload.envelope, this.deps.previousSigningKey) : undefined;
      const now = this.deps.now();
      if (!object(value) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= now || value.expiresAt > now + 30_000)
        return fail(401, "unauthorized", "A current app model assertion is required.");
      const app = text(value.app), requirement = text(value.requirement), pool = text(value.pool),
        person = text(value.person), authorizer = text(value.authorizer), owner = text(value.owner);
      const candidateNonce = text(value.nonce);
      if (!app || !requirement || !pool || !person || !authorizer || !owner || !candidateNonce
        || !/^[a-f0-9-]{36}$/.test(candidateNonce) || !text(value.binding)
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || (value.scope !== "app" && value.scope !== "user") || typeof value.background !== "boolean"
        || (value.scope === "user" && (value.background || person !== authorizer))
        || typeof value.timeoutMs !== "number" || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0
        || !object(value.body) || value.body.stream !== false || value.body.n !== 1
        || !text(value.body.model) || !Array.isArray(value.body.messages))
        return fail(400, "invalid_query", "The app model assertion is invalid.");
      const directory = await PoolDirectory.load(this.deps.storage, now);
      const entry = directory.entry(pool);
      if (!entry || entry.organization !== value.organization || entry.owner !== owner
        || (entry.authorization === "executor-app-v1" && !directory.permissions(pool, authorizer)?.canUse))
        return fail(403, "unauthorized", "This model binding no longer has pool access.");
      if (!(await this.deps.ready())) return fail(503, "backend_unavailable", "Model app attribution is not ready.");
      const timeoutMs = value.timeoutMs;
      const assertionExpires = value.expiresAt;
      const label = appModelLabel(app, requirement, candidateNonce);
      const admitted = await this.change((rows) => {
        if (Object.hasOwn(rows, candidateNonce)) return false;
        rows[candidateNonce] = { label, expiresAt: now + timeoutMs + 30_000,
          assertionExpires, state: "pending" };
        return true;
      });
      if (!admitted) return fail(409, "busy", "This model request was already dispatched. It will not run again.");
      nonce = candidateNonce;
      this.active.add(nonce);
      await this.deps.schedule(now + timeoutMs + 30_000);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      const issued = await this.deps.home.mintAppModel(person, pool, label, owner, signal);
      await this.change((rows) => { const row = rows[candidateNonce]; if (row) row.keyId = issued.keyId; });
      signal.throwIfAborted();
      const forwarded = new Request(new URL("/v1/chat/completions", request.url), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued.key}` },
        body: JSON.stringify(value.body), signal,
      });
      const response = await this.deps.forward(forwarded, { pool, person, keyId: issued.keyId, appId: app, requirement });
      // This API is finite. Read before revocation, so its key survives until Home has finished.
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2_097_152) return fail(502, "backend_unavailable", "The model response is too large.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const body = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof SyntaxError) return Response.json({ error: { code: "invalid_query", message: "The model request is invalid." } }, { status: 400 });
      return failureResponse(error);
    } finally {
      if (nonce !== undefined) {
        this.active.delete(nonce);
        const row = await this.change((rows) => { const row = rows[nonce!]; if (row) row.state = "cleanup"; return row; });
        if (row) try { await this.cleanup(nonce, row); }
        catch { await this.deps.schedule(this.deps.now() + 5_000); }
      }
    }
  }
}
