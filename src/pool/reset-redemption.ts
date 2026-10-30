import type { ResetResult } from "../../apps/pool/action-contract.ts";
import type { HomeClient } from "./control.ts";
import { digest } from "./backend-users.ts";
import { fail, post } from "./json.ts";
import { ProviderResets, resetUuid } from "./reset-provider.ts";

export interface ActionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface Attempt {
  provider: "codex" | "claude";
  creditId: string;
  organization?: string;
  startedAt: number;
  sent: boolean;
  result: ResetResult;
}
const succeeded = (result: ResetResult) => ["reset", "already_redeemed", "already_used"].includes(result.outcome);

/** The account action queue owns serialization. Receipts outlive retries and DO restarts. */
export class ResetRedemption {
  private storage: ActionStorage;
  private client: HomeClient;
  private now: () => number;
  constructor(storage: ActionStorage, client: HomeClient, now: () => number) {
    this.storage = storage; this.client = client; this.now = now;
  }

  async use(provider: ProviderResets, requestId: string, creditId: string, signal: AbortSignal, stillMember: () => Promise<void>): Promise<ResetResult> {
    if (!resetUuid.test(requestId) || !creditId || creditId.length > 256) {
      return fail(400, "invalid_query", "Provide a reset credit id and a UUID request id. Reuse that request id when retrying.");
    }
    requestId = requestId.toLowerCase();
    const accountKey = `reset-use-v1:${await digest(provider.id)}`;
    const receiptKey = `${accountKey}:${requestId}`;
    let attempt = await this.storage.get<Attempt>(receiptKey);
    if (attempt && (attempt.creditId !== creditId || attempt.provider !== provider.provider)) {
      return fail(409, "invalid_query", "This request id was already used for a different reset.");
    }
    if (!attempt) {
      const pendingId = await this.storage.get<string>(accountKey);
      const pending = pendingId ? await this.storage.get<Attempt>(`${accountKey}:${pendingId}`) : undefined;
      if (pending?.result.outcome === "unknown") {
        return fail(409, "invalid_query", "The previous reset outcome is unknown. Retry with its original request id before starting another reset.");
      }
      const credits = await provider.credits(signal);
      const credit = credits.credits.find((credit) => credit.id === creditId);
      if (!credit) return fail(404, "not_found", "This reset credit is no longer available.");
      if (credit.usableNow === false) return fail(409, "invalid_query", "This reset cannot be used right now.");
      const organization = await provider.organization(signal);
      await stillMember();
      attempt = { provider: provider.provider, creditId, organization, startedAt: this.now(), sent: false,
        result: { requestId, outcome: "unknown", cooldownCleared: false, usageRefreshQueued: false } };
      // Both writes precede the provider call. A crash between them cannot have spent a credit.
      await this.storage.put(receiptKey, attempt);
      await this.storage.put(accountKey, requestId);
    }
    if (attempt.result.outcome === "unknown") {
      // Claude's documented idempotency window is ten minutes. Past that boundary,
      // preserve the unknown result rather than risking a second spend with the same key.
      if (this.now() - attempt.startedAt >= 10 * 60_000) return attempt.result;
      await stillMember();
      const previouslySent = attempt.sent;
      attempt = { ...attempt, sent: true };
      await this.storage.put(receiptKey, attempt);
      try {
        let outcome = await provider.consume(requestId, attempt.creditId, attempt.organization, signal);
        // A later refusal says nothing about an earlier request whose reply was lost.
        if (previouslySent && !["reset", "already_redeemed", "already_used"].includes(outcome)) outcome = "unknown";
        attempt = { ...attempt, result: { ...attempt.result, outcome } };
      } catch { return attempt.result; }
      await this.storage.put(receiptKey, attempt);
    }
    if (!succeeded(attempt.result)) return attempt.result;
    // A confirmed spend survives failed follow-up work. Replays retry only the missing work.
    if (!attempt.result.cooldownCleared) {
      try {
        await stillMember();
        const result = await this.client.data(`/credentials/${encodeURIComponent(provider.id)}/cooldown`, { method: "DELETE", signal });
        if (typeof result.cleared === "boolean") attempt.result = { ...attempt.result, cooldownCleared: true };
      } catch { /* The receipt still records the confirmed provider outcome. */ }
    }
    if (!attempt.result.usageRefreshQueued) {
      try {
        await stillMember();
        const result = await this.client.data("/quota/collect", { ...post({ credential_ids: [provider.id] }), signal });
        if (typeof result.accepted === "number" && Number.isInteger(result.accepted) && result.accepted > 0) {
          this.client.dropQuotaDetail(provider.id);
          attempt.result = { ...attempt.result, usageRefreshQueued: true };
        }
      } catch { /* Retry the collection, never the confirmed spend. */ }
    }
    await this.storage.put(receiptKey, attempt);
    return attempt.result;
  }
}
