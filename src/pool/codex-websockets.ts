import type { HomeClient } from "./control.ts";
import { post, rows, text, unavailable, type Json } from "./json.ts";

const migrationLimit = 50;

async function credentials(client: HomeClient, signal?: AbortSignal): Promise<Json[]> {
  return rows((await client.data("/credentials", { signal })).files);
}

function credential(files: Json[], id: string): Json {
  const matching = files.filter((file) => file.id === id);
  if (matching.length !== 1) return unavailable();
  return matching[0]!;
}

function codex(file: Json): boolean { return (text(file.provider) ?? text(file.type)) === "codex"; }

async function enable(client: HomeClient, id: string, signal?: AbortSignal): Promise<void> {
  // Home's supported field patch persists metadata and synchronizes the effective attribute.
  const result = await client.data("/credentials/fields", { ...post({ id, websockets: true }), method: "PATCH", signal });
  if (result.status !== "ok") return unavailable();
  const saved = credential(await credentials(client, signal), id);
  if (!codex(saved) || saved.websockets !== true) return unavailable();
}

/** Call only after attribution has proved ownership and persisted the returned ids for retry. */
export async function enableNewCodexWebSockets(client: HomeClient, ids: string[], provider?: string): Promise<void> {
  if (provider !== undefined && provider !== "codex") return;
  const signal = AbortSignal.timeout(30_000);
  const files = await credentials(client, signal);
  for (const id of ids) {
    const file = credential(files, id);
    if (provider === "codex" && !codex(file)) return unavailable();
    // A prior patch may have saved true and failed its runtime reload. Require an ACK again.
    if (codex(file)) await enable(client, id, signal);
  }
}

export interface CodexWebSocketPlan {
  readonly total: number;
  readonly enabled: number;
  readonly pending: number;
  readonly writes: number;
  readonly digest: string;
  readonly limit: number;
}

/** Private operator RPC only. No cron or product route calls this migration. */
export async function migrateCodexWebSockets(client: HomeClient, approved?: Pick<CodexWebSocketPlan, "digest" | "pending">) {
  const signal = AbortSignal.timeout(30_000);
  const files = (await credentials(client, signal)).filter(codex);
  const ids = files.map((file) => text(file.id) ?? unavailable());
  if (new Set(ids).size !== ids.length) return unavailable();
  const selection = files.map((file) => [text(file.id) ?? unavailable(), file.websockets === true] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const pending = selection.filter(([, enabled]) => !enabled).length;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(selection))));
  const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const plan: CodexWebSocketPlan = { total: files.length, enabled: files.length - pending,
    pending, writes: files.length, digest, limit: migrationLimit };
  if (approved === undefined) return { ...plan, applied: 0, status: "dry-run" as const };
  // Bind GO to the exact dry-run selection. A changed or partially applied plan needs a new GO.
  if (approved.digest !== digest || approved.pending !== pending || files.length > migrationLimit) return unavailable();
  let applied = 0;
  // Include saved-true credentials: a previous failed response may have left reload uncertain.
  for (const [id] of selection) {
    try { await enable(client, id, signal); applied++; }
    catch { return { ...plan, applied, status: "incomplete" as const }; }
  }
  return { ...plan, applied, status: "complete" as const };
}
