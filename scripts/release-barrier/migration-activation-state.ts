import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Schema } from "effect";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import {
  checkpointReaderContract,
  migrationActivationTargets,
} from "./migration-activation-contract.ts";
import type { MigrationActivationReceipt } from "./migration-activation-contract.ts";
import { openRecovery, sealRecovery } from "./recovery-envelope.ts";
import { releaseOperationFingerprint } from "./release-operation.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const state = Schema.Literals(["active", "prepared", "unknown"]);
const receiptCodec = Schema.Struct({
  candidate: commit,
  fingerprint: hash,
  status: Schema.Literals(["pending", "complete"]),
  sent: Schema.optional(Schema.Literal(true)),
  result: Schema.optional(Schema.Struct({ hosted: state, pool: state })),
  intent: Schema.Struct({
    contract: Schema.Literal(checkpointReaderContract),
    targets: Schema.Tuple([
      Schema.Literal(migrationActivationTargets[0]),
      Schema.Literal(migrationActivationTargets[1]),
    ]),
    before: Schema.Struct({
      candidate: commit,
      sourceFingerprint: hash,
      readers: Schema.Struct({
        release: Schema.Struct({
          candidate: commit,
          deploymentId: Schema.Number,
          receiptDigest: hash,
        }),
        workers: Schema.Array(
          Schema.Struct({
            role: Schema.Literals(["Api", "AppPages", "PoolWorker"]),
            target: hash,
            versionId: Schema.String,
            acceptedVersionId: Schema.String,
            percentage: Schema.Number,
          }),
        ),
        poolAdoption: Schema.Struct({
          candidate: commit,
          poolWorkerRevision: Schema.String,
          imageInput: Schema.String,
        }),
        apps: Schema.Struct({ count: Schema.Number, fingerprint: hash }),
      }),
      hosted: Schema.Struct({
        prepared: Schema.Boolean,
        active: Schema.Boolean,
        fingerprint: hash,
      }),
      pool: Schema.Struct({
        prepared: Schema.Boolean,
        active: Schema.Boolean,
        schemaHash: hash,
        catalogHash: hash,
        report: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  }),
});
const headerCodec = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: commit,
  fingerprint: hash,
  complete: Schema.Boolean,
  sealed: Schema.Unknown,
});

function decodeReceipt(value: unknown, candidate: string): MigrationActivationReceipt {
  try {
    const decoded = Schema.decodeUnknownSync(receiptCodec, { onExcessProperty: "error" })(value);
    if (
      decoded.sent !== true ||
      decoded.candidate !== candidate ||
      decoded.intent.before.candidate !== candidate ||
      canonical(decoded.intent.targets) !== canonical(migrationActivationTargets) ||
      decoded.fingerprint !== releaseOperationFingerprint(candidate, decoded.intent) ||
      (decoded.status === "complete" &&
        (decoded.result?.hosted !== "active" || decoded.result.pool !== "active"))
    )
      throw new Error();
    return decoded;
  } catch {
    throw new BarrierRefusal("migration-activation-journal-invalid", "State");
  }
}

/** This output never shares a key with the ordinary release or SQL schema journals. */
export function migrationActivationJournal(
  store: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
  candidate: string,
  encryptionKey: string,
) {
  const location = { stack: `${stack.name}-migration-activation`, stage: stack.stage };
  const read = async () => {
    try {
      const value = await Effect.runPromise(store.getOutput(location));
      if (value === undefined) return undefined;
      const header = Schema.decodeUnknownSync(headerCodec, { onExcessProperty: "error" })(value);
      const receipt = decodeReceipt(
        openRecovery(header.sealed, encryptionKey, header.candidate, header.fingerprint),
        header.candidate,
      );
      if (
        header.fingerprint !== receipt.fingerprint ||
        header.complete !== (receipt.status === "complete")
      )
        throw new Error();
      return receipt;
    } catch {
      throw new BarrierRefusal("migration-activation-journal-unreadable", "State");
    }
  };
  const load = async () => {
    const receipt = await read();
    if (receipt && receipt.candidate !== candidate) {
      if (receipt.status !== "complete")
        throw new BarrierRefusal("migration-activation-pending", "State");
      return undefined;
    }
    return receipt;
  };
  return {
    load,
    save: async (value: MigrationActivationReceipt) => {
      const receipt = decodeReceipt(value, candidate);
      const prior = await read();
      if (
        receipt.sent !== true ||
        (prior &&
          ((prior.status !== "complete" && prior.fingerprint !== receipt.fingerprint) ||
            (prior.candidate === candidate &&
              prior.status === "complete" &&
              canonical(prior) !== canonical(receipt))))
      )
        throw new BarrierRefusal("migration-activation-journal-overwrite", "State");
      try {
        await Effect.runPromise(
          store.setOutput({
            ...location,
            value: {
              schemaVersion: 1,
              candidate,
              fingerprint: receipt.fingerprint,
              complete: receipt.status === "complete",
              sealed: sealRecovery(receipt, encryptionKey, candidate, receipt.fingerprint),
            },
          }),
        );
      } catch {
        throw new BarrierRefusal("migration-activation-journal-write", "State");
      }
    },
  };
}

/** Ordinary releases only observe this guard; an uncertain activation blocks every candidate. */
export const assertMigrationActivationSettled = (
  store: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
  encryptionKey: string,
) =>
  Effect.gen(function* () {
    const value = yield* store
      .getOutput({ stack: `${stack.name}-migration-activation`, stage: stack.stage })
      .pipe(
        Effect.mapError(
          () => new BarrierRefusal("migration-activation-journal-unreadable", "State"),
        ),
      );
    if (value === undefined) return;
    const receipt = yield* Effect.try({
      try: () => {
        const header = Schema.decodeUnknownSync(headerCodec, { onExcessProperty: "error" })(value);
        const decoded = decodeReceipt(
          openRecovery(header.sealed, encryptionKey, header.candidate, header.fingerprint),
          header.candidate,
        );
        if (
          header.fingerprint !== decoded.fingerprint ||
          header.complete !== (decoded.status === "complete")
        )
          throw new Error();
        return decoded;
      },
      catch: () => new BarrierRefusal("migration-activation-journal-unreadable", "State"),
    });
    if (receipt.status !== "complete")
      throw new BarrierRefusal("migration-activation-pending", "State");
  });
