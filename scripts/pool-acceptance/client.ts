import { verifySse } from "./sse.ts";
import {
  AcceptanceFailure,
  HttpStatusFailure,
  isObject,
  TransportFailure,
  type Conversation,
  type ModelCatalog,
  type PoolAccess,
  type UsageRecord,
} from "./types.ts";

const requestTimeoutMs = 60_000;
const streamTimeoutMs = 5 * 60 * 1_000;
const usagePollWindowMs = 45_000;
const usagePollIntervalMs = 1_000;

type ClientOptions = {
  readonly origin?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly usagePollWindowMs?: number;
  readonly usagePollIntervalMs?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Do not include response bodies in logs.
  }
}

function requireBoot(response: Response): string {
  const boot = response.headers.get("X-Signalbox-Pool-Boot")?.trim();
  if (!boot) throw new AcceptanceFailure("Pool response omitted X-Signalbox-Pool-Boot");
  return boot;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AcceptanceFailure(`${label} did not return valid JSON`);
  }
}

function modelIds(payload: unknown): string[] {
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new AcceptanceFailure("/v1/models did not return a data array");
  }
  return [...new Set(payload.data.flatMap((entry) =>
    isObject(entry) && typeof entry.id === "string" && entry.id.trim() ? [entry.id] : []
  ))];
}

function usageRecord(value: unknown): UsageRecord {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim()
    || typeof value.account !== "string" || !value.account.trim()) {
    throw new AcceptanceFailure("Pool usage records omitted id or account");
  }
  if (value.status !== "success") {
    throw new AcceptanceFailure("Pool usage records did not show successful requests");
  }
  if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) {
    throw new AcceptanceFailure("Pool usage records omitted a valid timestamp");
  }
  return { id: value.id, account: value.account, status: value.status, at: value.at };
}

export class PoolAcceptanceClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly usagePollWindowMs: number;
  private readonly usagePollIntervalMs: number;

  constructor(options: ClientOptions = {}) {
    this.origin = options.origin ?? "https://app.signalbox.run";
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => performance.now());
    this.delay = options.delay ?? delay;
    this.usagePollWindowMs = options.usagePollWindowMs ?? usagePollWindowMs;
    this.usagePollIntervalMs = options.usagePollIntervalMs ?? usagePollIntervalMs;
  }

  async request(
    path: string,
    init: RequestInit,
    label: string,
    timeoutMs = requestTimeoutMs,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.origin), {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
      });
    } catch {
      throw new TransportFailure(`${label} did not return an HTTP response`);
    }
  }

  async modelCatalog(apiKey: string, timeoutMs = requestTimeoutMs): Promise<ModelCatalog> {
    const response = await this.request("/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, "/v1/models", timeoutMs);
    if (response.status !== 200) {
      await discardBody(response);
      throw new HttpStatusFailure(response.status, `/v1/models returned HTTP ${response.status}`);
    }
    const boot = requireBoot(response);
    const ids = modelIds(await readJson(response, "/v1/models"));
    return { boot, ids, completedAt: this.now() };
  }

  async testAccountIds(access: PoolAccess): Promise<Set<string>> {
    const response = await this.request("/pool/v1/pool", {
      headers: { Authorization: `Bearer ${access.token}`, "x-signalbox-caller": access.owner },
    }, "/pool/v1/pool");
    if (response.status !== 200) {
      await discardBody(response);
      throw new AcceptanceFailure(`/pool/v1/pool returned HTTP ${response.status}`);
    }
    const payload = await readJson(response, "/pool/v1/pool");
    if (!isObject(payload) || payload.isOwner !== true || !Array.isArray(payload.accounts)) {
      throw new AcceptanceFailure("The test pool did not return its owner's accounts list");
    }
    const ids = payload.accounts.map((account: unknown) => {
      if (!isObject(account) || typeof account.id !== "string" || !account.id.trim()) {
        throw new AcceptanceFailure("The test pool accounts list omitted an account ID");
      }
      return account.id;
    });
    if (ids.length !== 2 || new Set(ids).size !== 2) {
      throw new AcceptanceFailure("The dedicated test pool must contain exactly two distinct accounts");
    }
    return new Set(ids);
  }

  async sendTurn(
    apiKey: string,
    model: string,
    conversation: Conversation,
  ): Promise<{ boot: string; firstByteMs: number; totalMs: number }> {
    const requestStarted = this.now();
    const response = await this.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Session-ID": conversation.id,
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
      }),
    }, "/v1/chat/completions", streamTimeoutMs);
    if (response.status !== 200) {
      await discardBody(response);
      throw new HttpStatusFailure(response.status, `/v1/chat/completions returned HTTP ${response.status}`);
    }
    const boot = requireBoot(response);
    return { boot, ...(await verifySse(response, requestStarted, { now: this.now })) };
  }

  private async listUsageRecords(
    access: PoolAccess,
    conversation: Conversation,
    timeoutMs: number,
  ): Promise<UsageRecord[]> {
    // The Worker owns the node's canonical session encoding and pool membership filter.
    const query = new URLSearchParams({ session: conversation.id, limit: "20", status: "success" });
    const response = await this.request(`/pool/v1/usage?${query}`, {
      headers: { Authorization: `Bearer ${access.token}`, "x-signalbox-caller": access.owner },
    }, "/pool/v1/usage", timeoutMs);
    if (response.status !== 200) {
      await discardBody(response);
      throw new AcceptanceFailure(`/pool/v1/usage returned HTTP ${response.status}`);
    }
    const payload: unknown = await readJson(response, "/pool/v1/usage");
    if (!isObject(payload) || !Array.isArray(payload.records)) {
      throw new AcceptanceFailure("Pool usage response did not contain records[]");
    }
    const records = payload.records.map(usageRecord);
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new AcceptanceFailure("Pool usage records contained duplicate IDs");
    }
    return records;
  }

  async waitForUsageRecords(
    access: PoolAccess,
    conversation: Conversation,
  ): Promise<UsageRecord[]> {
    const deadline = this.now() + this.usagePollWindowMs;
    while (true) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new AcceptanceFailure(
          `Pool usage records remained incomplete after ${this.usagePollWindowMs} ms`,
        );
      }
      const records = await this.listUsageRecords(access, conversation, remaining);
      if (records.length > conversation.expectedRecords) {
        throw new AcceptanceFailure(
          `Pool usage records matched ${records.length} rows; expected ${conversation.expectedRecords}`,
        );
      }
      if (records.length === conversation.expectedRecords) return records;

      const timeLeft = deadline - this.now();
      if (timeLeft <= 0) {
        throw new AcceptanceFailure(
          `Pool usage records matched ${records.length} rows; expected ${conversation.expectedRecords} before the polling deadline`,
        );
      }
      await this.delay(Math.min(this.usagePollIntervalMs, timeLeft));
    }
  }
}
