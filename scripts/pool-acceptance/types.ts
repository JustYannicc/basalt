export class AcceptanceFailure extends Error {}

export class TransportFailure extends AcceptanceFailure {}

/**
 * What a refusal's JSON body says, as codes only: `error.code`, `error.type`, and the code a message
 * begins with (`<code>: …`, how the pool's node relays a Home refusal). Never the message itself.
 */
export type Refusal = { readonly code?: string; readonly type?: string; readonly prefix?: string };

export class HttpStatusFailure extends AcceptanceFailure {
  readonly status: number;
  readonly refusal: Refusal | undefined;

  constructor(status: number, message: string, refusal?: Refusal) {
    super(message);
    this.status = status;
    this.refusal = refusal;
  }
}

/** A model call's 429 carrying the pool's cap code: its user's cap, not a failure to serve. */
export class UserCapReached extends HttpStatusFailure {
  constructor(message: string, refusal?: Refusal) {
    super(429, message, refusal);
  }
}

export type JsonObject = Record<string, unknown>;

export type Conversation = {
  readonly id: string;
  readonly expectedRecords: number;
};

export type { UsageRecord } from "../../apps/pool/contract.ts";

export type PoolAccess = {
  readonly token: string;
  readonly owner: string;
};

/**
 * A pool made only for acceptance. Usage is read there with an owner token minted from the app
 * signing key, which is never minted for a pool that holds people's work.
 */
export const isAcceptancePool = (pool: string) => /^acceptance-[a-zA-Z0-9-]+$/u.test(pool);

export type ModelCatalog = {
  readonly boot: string;
  readonly ids: string[];
  readonly completedAt: number;
};

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
