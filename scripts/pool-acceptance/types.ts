export class AcceptanceFailure extends Error {}

export class TransportFailure extends AcceptanceFailure {}

export class HttpStatusFailure extends AcceptanceFailure {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

export type ModelCatalog = {
  readonly boot: string;
  readonly ids: string[];
  readonly completedAt: number;
};

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
