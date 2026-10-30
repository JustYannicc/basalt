import type { HomeClient, PoolHome } from "./control.ts";
import { accountsView } from "./accounts-view.ts";
import { fail, json, post, unavailable } from "./json.ts";
import { ProviderResets } from "./reset-provider.ts";
import { ResetRedemption, type ActionStorage } from "./reset-redemption.ts";
import type { QuotaCollection } from "./quota-collection.ts";

export type AccountAction = "refresh" | "pause" | "resume" | "cooldown/clear" | "resets" | "resets/use";
export const accountActionPath = /^\/accounts\/([^/]+)\/(refresh|pause|resume|cooldown\/clear|resets(?:\/use)?)$/;

export class AccountActions {
  private queue = new Map<string, Promise<unknown>>();
  private redemption: ResetRedemption;
  private client: HomeClient;
  private collection: QuotaCollection;
  private now: () => number;
  constructor(client: HomeClient, storage: ActionStorage, collection: QuotaCollection, now: () => number) {
    this.client = client; this.collection = collection; this.now = now;
    this.redemption = new ResetRedemption(storage, client, now);
  }

  async handle(home: PoolHome, id: string, action: AccountAction, request: Request): Promise<Response> {
    const previous = this.queue.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.execute(home, id, action, request));
    this.queue.set(id, work);
    try { return await work; }
    finally { if (this.queue.get(id) === work) this.queue.delete(id); }
  }

  private async execute(home: PoolHome, id: string, action: AccountAction, request: Request): Promise<Response> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]);
    if (!id || id.length > 256 || /[\p{Cc}/\\]/u.test(id)) return fail(400, "invalid_query", "Provide a valid account id.");
    const stillMember = async () => {
      const membership = home.ownMembership(await home.allMembership(signal));
      if (!membership.members.some((member) => member.auth_id === id)) return fail(404, "not_found", "This account is not in this pool.");
    };
    await stillMember();
    const files = (await home.credentials(signal)).filter((row) => row.id === id);
    if (files.length !== 1) return files.length ? unavailable() : fail(404, "not_found", "This account no longer exists.");
    const provider = files[0]!.provider ?? files[0]!.type;
    if (action === "refresh") {
      const reading = await this.collection.refresh(id, signal);
      const account = accountsView(files, reading ? [reading] : [], new Set([id]))[0];
      return account ? json(account) : unavailable();
    }
    if (action === "pause" || action === "resume") {
      const disabled = action === "pause";
      await stillMember();
      const result = await this.client.data("/credentials/status", { ...post({ name: id, disabled }), method: "PATCH", signal });
      if (result.status !== "ok" || result.disabled !== disabled) return unavailable();
      this.client.dropQuotaDetail(id);
      return json({ disabled });
    }
    if (action === "cooldown/clear") {
      await stillMember();
      const result = await this.client.data(`/credentials/${encodeURIComponent(id)}/cooldown`, { method: "DELETE", signal });
      if (typeof result.cleared !== "boolean") return unavailable();
      return json({ cleared: result.cleared });
    }
    if (provider !== "codex" && provider !== "claude") return fail(400, "unknown_provider", "This provider does not support banked resets.");
    const resets = new ProviderResets(this.client, id, provider, this.now);
    if (action === "resets") return json(await resets.credits(signal));
    let body: unknown;
    try { body = await request.json(); } catch { return fail(400, "invalid_query", "Provide a reset credit id and request id."); }
    if (!body || typeof body !== "object" || !("requestId" in body) || typeof body.requestId !== "string"
      || !("creditId" in body) || typeof body.creditId !== "string") return fail(400, "invalid_query", "Provide a reset credit id and request id.");
    return json(await this.redemption.use(resets, body.requestId, body.creditId, signal, stillMember));
  }
}
