import type { ReleaseOperationReceipt } from "./release-operation.ts";

export const checkpointReaderContract = "checkpoint-count-v1";
export const migrationActivationTargets = [
  "22_change_journal_activate",
  "model_request_history_v10_change_journal_activate",
] as const;

export interface MigrationReaderEvidence {
  readonly release: {
    readonly candidate: string;
    readonly deploymentId: number;
    readonly receiptDigest: string;
  };
  readonly workers: readonly {
    readonly role: "Api" | "AppPages" | "PoolWorker";
    readonly target: string;
    readonly versionId: string;
    readonly acceptedVersionId: string;
    readonly percentage: number;
  }[];
  readonly poolAdoption: {
    readonly candidate: string;
    readonly poolWorkerRevision: string;
    readonly imageInput: string;
  };
  readonly apps: { readonly count: number; readonly fingerprint: string };
}

export interface MigrationActivationSnapshot {
  readonly candidate: string;
  readonly sourceFingerprint: string;
  readonly readers: MigrationReaderEvidence;
  readonly hosted: {
    readonly prepared: boolean;
    readonly active: boolean;
    readonly fingerprint: string;
  };
  readonly pool: {
    readonly prepared: boolean;
    readonly active: boolean;
    readonly schemaHash: string;
    readonly catalogHash: string;
    readonly report: Readonly<Record<string, unknown>>;
  };
}

export interface MigrationActivationIntent {
  readonly contract: typeof checkpointReaderContract;
  readonly targets: typeof migrationActivationTargets;
  readonly before: MigrationActivationSnapshot;
}

export interface MigrationActivationResult {
  readonly hosted: "active" | "prepared" | "unknown";
  readonly pool: "active" | "prepared" | "unknown";
}

export type MigrationActivationReceipt = ReleaseOperationReceipt<
  MigrationActivationIntent,
  MigrationActivationResult
>;

export interface MigrationActivationPorts {
  read(): Promise<MigrationActivationSnapshot>;
  activate(intent: MigrationActivationIntent): Promise<void>;
  inspect(intent: MigrationActivationIntent): Promise<{
    status: "pending" | "complete";
    result: MigrationActivationResult;
  }>;
  load(): Promise<MigrationActivationReceipt | undefined>;
  save(receipt: MigrationActivationReceipt): Promise<void>;
}
