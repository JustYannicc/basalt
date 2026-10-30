import type { ResetCredit, ResetCredits, ResetOutcome, ResetWindow } from "../../apps/pool/action-contract.ts";
import type { HomeClient } from "./control.ts";
import { fail, object, post, rows, text, unavailable, type Json } from "./json.ts";

export const resetUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const grantId = /^[a-z0-9_-]{1,40}$/;
const windows: readonly ResetWindow[] = ["five_hour", "seven_day", "seven_day_overage_included"];
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
function timestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : unavailable();
}

/** Provider URLs and token substitution stay behind this interface; callers supply only account and credit IDs. */
export class ProviderResets {
  private client: HomeClient;
  readonly id: string;
  readonly provider: "codex" | "claude";
  private now: () => number;
  constructor(client: HomeClient, id: string, provider: "codex" | "claude", now: () => number) {
    this.client = client; this.id = id; this.provider = provider; this.now = now;
  }

  private async request(path: "credits" | "grants" | "profile" | "consume", signal: AbortSignal, body?: Json, organization?: string) {
    let url: string;
    const header: Record<string, string> = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json" };
    if (this.provider === "codex") {
      if (path !== "credits" && path !== "consume") return unavailable();
      url = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits" + (path === "consume" ? "/consume" : "");
      // Home's credential list omits this routing identity. Read the supported export internally,
      // retaining neither tokens nor the file, so workspace subscriptions use their own account.
      const file = await this.client.data(`/credentials/download?${new URLSearchParams({ id: this.id })}`, { signal });
      if (file.type !== "codex") return unavailable();
      const account = text(file.account_id) ?? text(file.chatgpt_account_id);
      if (account) {
        if (account.length > 256 || /[\r\n]/.test(account)) return unavailable();
        header["Chatgpt-Account-Id"] = account;
      }
      header["User-Agent"] = "codex-tui/0.149.1";
    } else {
      header["anthropic-beta"] = "oauth-2025-04-20";
      header["User-Agent"] = "claude-cli/2.1.304 (external, cli)";
      if (path === "profile") url = "https://api.anthropic.com/api/oauth/profile";
      else if (path === "grants") url = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
      else if (path === "consume" && organization && resetUuid.test(organization)) {
        url = `https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`;
      } else return unavailable();
    }
    const response = await this.client.data("/requests/api-call", {
      ...post({ auth_index: this.id, method: body ? "POST" : "GET", url, header,
        ...(body ? { data: JSON.stringify(body) } : {}) }), signal,
    });
    if (typeof response.status_code !== "number" || !Number.isInteger(response.status_code)
      || typeof response.body !== "string" || response.body.length > 1024 * 1024) return unavailable();
    let value: unknown;
    try { value = JSON.parse(response.body); } catch { value = null; }
    return { status: response.status_code, body: object(value) ? value : null };
  }

  private async read(path: "credits" | "grants" | "profile", signal: AbortSignal): Promise<Json> {
    const response = await this.request(path, signal);
    if (response.status < 200 || response.status >= 300 || !response.body) return unavailable();
    return response.body;
  }

  async credits(signal: AbortSignal): Promise<ResetCredits> {
    const value = await this.read(this.provider === "codex" ? "credits" : "grants", signal);
    const now = this.now();
    const credits: ResetCredit[] = [];
    if (this.provider === "codex") {
      for (const row of rows(value.credits)) {
        if (row.status !== "available" || row.reset_type !== "codex_rate_limits") continue;
        const id = text(row.id);
        if (!id || id.length > 256) return unavailable();
        const expiresAt = timestamp(row.expires_at);
        if (expiresAt && Date.parse(expiresAt) <= now) continue;
        credits.push({ id, type: "codex_rate_limits", remaining: 1, expiresAt,
          usableNow: null, requiresLimit: false, clears: null });
      }
    } else {
      const status = value.cedar_ember;
      if (!object(status) || typeof status.eligible !== "boolean" || status.ineligible_reason === "unavailable") return unavailable();
      if (status.eligible) for (const row of rows(status.grants)) {
        const id = text(row.id);
        if (!id || !grantId.test(id) || !count(row.resets_left) || typeof row.usable_now !== "boolean"
          || typeof row.use_requires_limit !== "boolean" || typeof row.paused !== "boolean") return unavailable();
        const startsAt = timestamp(row.starts_at);
        const expiresAt = timestamp(row.ends_at);
        if (row.resets_left === 0 || row.paused || startsAt && Date.parse(startsAt) > now || expiresAt && Date.parse(expiresAt) <= now) continue;
        if (!Array.isArray(row.clears) || row.clears.some((value) => typeof value !== "string")) return unavailable();
        const clears = windows.filter((window) => (row.clears as string[]).includes(window));
        credits.push({ id, type: "cedar_ember", remaining: row.resets_left, expiresAt,
          usableNow: row.usable_now && (!row.use_requires_limit || status.at_limit === true), requiresLimit: row.use_requires_limit, clears });
      }
    }
    if (credits.length > 100 || new Set(credits.map((credit) => credit.id)).size !== credits.length) return unavailable();
    credits.sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || a.id.localeCompare(b.id));
    return { provider: this.provider, observedAt: new Date(now).toISOString(),
      available: credits.reduce((sum, credit) => sum + credit.remaining, 0), credits };
  }

  async organization(signal: AbortSignal): Promise<string | undefined> {
    if (this.provider !== "claude") return undefined;
    const value = await this.read("profile", signal);
    const id = object(value.organization) ? text(value.organization.uuid) : null;
    return id && resetUuid.test(id) ? id.toLowerCase() : unavailable();
  }

  async consume(requestId: string, creditId: string, organization: string | undefined, signal: AbortSignal): Promise<ResetOutcome> {
    const body = this.provider === "codex" ? { redeem_request_id: requestId, credit_id: creditId }
      : { program: "cedar_ember", grant_id: creditId, request_id: requestId };
    const response = await this.request("consume", signal, body, organization);
    if (response.status === 401 || response.status === 403) return "auth_error";
    if (response.status === 429) return "rate_limited";
    if (response.status < 200 || response.status >= 300) return "unknown";
    const code = this.provider === "codex" ? response.body?.code : response.body?.result;
    const known: readonly ResetOutcome[] = this.provider === "codex"
      ? ["reset", "already_redeemed", "nothing_to_reset", "no_credit"]
      : ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"];
    return known.find((outcome) => outcome === code) ?? "unknown";
  }
}
