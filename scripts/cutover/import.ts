import { verifySse } from "../pool-acceptance/sse.ts";

export interface ImportAccount { readonly file: Record<string, unknown>; readonly model: string }
export interface ImportConfig {
  readonly origin: string;
  readonly poolToken: string;
  readonly owner: string;
  readonly apiKey: string;
  readonly accounts: readonly ImportAccount[];
  readonly attempts?: number;
}
export class ImportFailure extends Error {
  readonly stage: "inputs" | "owner" | "upload" | "request" | "verification";
  readonly completed: number;
  constructor(stage: ImportFailure["stage"], completed = 0) {
    super(`Import stopped at ${stage}. ${completed} accounts verified. Uploaded accounts may remain; inspect the pool before retrying.`);
    this.stage = stage;
    this.completed = completed;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\p{Cc}]/u.test(value);
}
export function validateImport(config: ImportConfig): void {
  try {
    const url = new URL(config.origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash
      || ![config.poolToken, config.owner, config.apiKey].every(nonempty)
      || !Array.isArray(config.accounts) || !config.accounts.length || config.accounts.length > 50
      || !Number.isInteger(config.attempts ?? 6) || (config.attempts ?? 6) < 1 || (config.attempts ?? 6) > 20) throw 0;
    for (const account of config.accounts) {
      if (!object(account.file) || !nonempty(account.file.type) || !nonempty(account.model)
        || Buffer.byteLength(JSON.stringify(account.file)) > 1024 * 1024) throw 0;
    }
  } catch { throw new ImportFailure("inputs"); }
}

/** Only the supported owner control API is used. No backend management key is accepted. */
export async function importAccounts(config: ImportConfig, dependencies: {
  fetch?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
} = {}): Promise<{ verified: number }> {
  validateImport(config);
  const fetcher = dependencies.fetch ?? fetch;
  const delay = dependencies.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let completed = 0;
  const controlHeaders = { Authorization: `Bearer ${config.poolToken}`, "x-signalbox-caller": config.owner };
  async function request(path: string, init: RequestInit, stage: ImportFailure["stage"]): Promise<Response> {
    try {
      const response = await fetcher(new URL(path, config.origin), {
        ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw 0;
      }
      return response;
    } catch { throw new ImportFailure(stage, completed); }
  }
  async function json(path: string, init: RequestInit, stage: ImportFailure["stage"]): Promise<Record<string, unknown>> {
    const response = await request(path, init, stage);
    const reader = response.body?.getReader();
    if (!reader) throw new ImportFailure(stage, completed);
    try {
      let length = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 1024 * 1024) throw 0;
        chunks.push(part.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!object(value)) throw 0;
      return value;
    } catch { throw new ImportFailure(stage, completed); }
    finally { await reader.cancel().catch(() => {}); }
  }
  const view = await json("/pool/v1/pool", { headers: controlHeaders }, "owner");
  if (view.isOwner !== true || !Array.isArray(view.accounts)) throw new ImportFailure("owner");
  const verified = new Set<string>();
  for (const account of config.accounts) {
    const result = await json("/pool/v1/login-files", {
      method: "POST", headers: { ...controlHeaders, "Content-Type": "application/json" }, body: JSON.stringify(account.file),
    }, "upload");
    if (!nonempty(result.accountId)) throw new ImportFailure("upload", completed);
    const id = result.accountId;
    if (verified.has(id)) throw new ImportFailure("verification", completed);
    let served = false;
    for (let attempt = 0; attempt < (config.attempts ?? 6) && !served; attempt++) {
      const session = crypto.randomUUID();
      const response = await request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "X-Session-ID": session },
        body: JSON.stringify({ model: account.model, stream: true, max_tokens: 16,
          messages: [{ role: "user", content: "Reply with exactly OK." }] }),
      }, "request");
      try { await verifySse(response, performance.now()); }
      catch { throw new ImportFailure("request", completed); }
      // A 200 stream alone could have used another account. Require exact usage attribution.
      for (let poll = 0; poll < 45; poll++) {
        const query = new URLSearchParams({ session, status: "success", limit: "20" });
        const usage = await json(`/pool/v1/usage?${query}`, { headers: controlHeaders }, "verification");
        if (!Array.isArray(usage.records)) throw new ImportFailure("verification", completed);
        if (usage.records.length) {
          served = usage.records.some((row) => object(row) && row.account === id && row.status === "success"
            && typeof row.at === "string" && Number.isFinite(Date.parse(row.at)));
          break;
        }
        if (poll === 44) throw new ImportFailure("verification", completed);
        await delay(1000);
      }
    }
    if (!served) throw new ImportFailure("verification", completed);
    verified.add(id);
    completed++;
  }
  return { verified: completed };
}
