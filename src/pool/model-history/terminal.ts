import { digest } from "../backend-users.ts";
import { endpointMetadata, invalidHistory, reference, timestamp } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";

export type TerminalOutcome =
  | "complete"
  | "truncated"
  | "client_closed"
  | "provider_failed"
  | "unavailable";

export interface TerminalStart {
  requestId: string;
  pool: string;
  person: string | null;
  keyId?: number;
  at: string;
  pathname: string;
}

export interface TerminalFinish {
  outcome: TerminalOutcome;
  status: number;
  bytes: number;
  at: string;
}

const homeSource = "home-local-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const outcomes = new Set<TerminalOutcome>([
  "complete",
  "truncated",
  "client_closed",
  "provider_failed",
  "unavailable",
]);

function requestId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return invalidHistory();
  return value;
}

function count(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalidHistory();
  return String(value);
}

/** Store only digests and a closed route label; raw key, body and pathname never reach SQL. */
export async function recordTerminalStart(
  db: HistoryDatabase,
  input: TerminalStart,
): Promise<void> {
  const id = requestId(input.requestId);
  if (typeof input.pool !== "string" || input.pool.length < 1 || input.pool.length > 256)
    return invalidHistory();
  if (input.person !== null && !/^[a-f0-9]{64}$/.test(input.person)) return invalidHistory();
  if (input.keyId !== undefined && (!Number.isSafeInteger(input.keyId) || input.keyId < 0))
    return invalidHistory();
  if (typeof input.pathname !== "string" || input.pathname.length > 2048) return invalidHistory();

  const source = await digest(homeSource);
  const clientKey = await reference(source, "key", input.keyId);
  const endpoint = endpointMetadata(input.pathname).endpoint;
  await db.query(
    `INSERT INTO basalt_model_terminal_starts
      (request_id,pool,person,client_key,endpoint,started_at)
    VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz)
    ON CONFLICT (request_id) DO NOTHING`,
    [
      id,
      (await digest(input.pool)).slice(0, 16),
      input.person,
      clientKey,
      endpoint,
      timestamp(input.at),
    ],
  );
}

/** The first finish is authoritative. A repeat cannot rewrite terminal evidence. */
export async function recordTerminalFinish(
  db: HistoryDatabase,
  requestIdValue: string,
  result: TerminalFinish,
): Promise<void> {
  const id = requestId(requestIdValue);
  if (!outcomes.has(result.outcome)) return invalidHistory();
  if (!Number.isSafeInteger(result.status) || result.status < 100 || result.status > 599)
    return invalidHistory();
  const bytes = count(result.bytes);
  await db.query(
    `INSERT INTO basalt_model_terminal_finishes
      (request_id,outcome,status,bytes,finished_at)
    SELECT request_id,$2,$3,$4::bigint,$5::timestamptz
    FROM basalt_model_terminal_starts WHERE request_id=$1::uuid
    ON CONFLICT (request_id) DO NOTHING`,
    [id, result.outcome, result.status, bytes, timestamp(result.at)],
  );
}
