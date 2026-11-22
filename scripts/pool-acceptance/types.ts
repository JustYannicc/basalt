export class AcceptanceFailure extends Error {}

export class TransportFailure extends AcceptanceFailure {}

export class HttpStatusFailure extends AcceptanceFailure {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A model call's 429 carrying the pool's cap code: its user's cap, not a failure to serve. */
export class UserCapReached extends HttpStatusFailure {
  constructor(message: string) {
    super(429, message);
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
