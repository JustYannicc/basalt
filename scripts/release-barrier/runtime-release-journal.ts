import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Schema } from "effect";
import { RuntimeReleaseState } from "./runtime-release-state.ts";
import { RuntimeProvisioningManifest } from "./provisioning-contract.ts";
import { ImageUpdateIntent } from "../../src/pool/runtime-fleet/image-update.ts";
import { RuntimeConfiguration } from "../../src/pool/runtime-slots/configuration.ts";
import { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";
import { openRecovery, sealRecovery } from "./recovery-envelope.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";

const Record = Schema.Struct({
  format: Schema.Literal("pool-image-release-v1"),
  candidate: Schema.String,
  complete: Schema.Boolean,
  baseline: RuntimeReleaseState,
  desiredInput: Schema.String,
  desiredConfiguration: RuntimeConfiguration,
  bootstrap: Schema.Record(Schema.String, RuntimeProvisioningManifest),
  configurations: Schema.Record(Schema.String, FleetConfiguration),
  update: Schema.optional(ImageUpdateIntent),
});
export type RuntimeReleaseRecord = typeof Record.Type;
const Header = Schema.Struct({
  candidate: Schema.String,
  fingerprint: Schema.String,
  sealed: Schema.Unknown,
});

/** Kept separately from each Alchemy phase's forward journal; secrets remain encrypted. */
export const runtimeReleaseJournal = (
  stack: Pick<CompiledStack, "name" | "stage">,
  writer: RuntimeReleaseWriter,
  encryptionKey: string,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const key = { stack: `${stack.name}-runtime-image-release`, stage: stack.stage };
    const read = async () => {
      const raw = await Effect.runPromise(state.getOutput(key));
      if (raw === undefined) return undefined;
      const header = Schema.decodeUnknownSync(Header)(raw);
      const record = Schema.decodeUnknownSync(Record)(
        openRecovery(header.sealed, encryptionKey, header.candidate, header.fingerprint),
      );
      if (record.candidate !== header.candidate || digest(canonical(record)) !== header.fingerprint)
        throw new BarrierRefusal("runtime-release-journal-identity", "PoolWorker");
      if (record.candidate !== writer.candidate) {
        if (record.complete) return undefined;
        throw new BarrierRefusal("runtime-release-prior-candidate-unsettled", "PoolWorker");
      }
      return record;
    };
    return {
      read,
      write: (value: RuntimeReleaseRecord) =>
        writer.exclusive(async () => {
          const record = Schema.decodeUnknownSync(Record)(value);
          if (record.candidate !== writer.candidate)
            throw new BarrierRefusal("runtime-release-journal-candidate", "PoolWorker");
          const fingerprint = digest(canonical(record));
          await Effect.runPromise(
            state.setOutput({
              ...key,
              value: {
                candidate: record.candidate,
                fingerprint,
                sealed: sealRecovery(record, encryptionKey, record.candidate, fingerprint),
              },
            }),
          );
        }),
    };
  });
