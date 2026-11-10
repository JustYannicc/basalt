import type { StateService } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import { sealRecovery } from "./recovery-envelope.ts";
import { journalKey } from "./forward-journal.ts";
import { provisioningRefusal } from "./provisioning-refusal.ts";
import { type ProvisioningStore } from "./provisioning-journal.ts";
import { readRuntimeProvisioningHeader } from "./provisioning-header.ts";
const legacy = Schema.Struct({ schemaVersion: Schema.Literal(1), complete: Schema.Boolean });

/** Production construction requires the release workflow's exclusive writer lease, never a no-op lock. */
export function stateProvisioningStore(
  state: StateService,
  scope: { name: string; stage: string },
  key: string,
  exclusive: ProvisioningStore["exclusive"],
): ProvisioningStore {
  const target = journalKey(scope);
  return {
    exclusive,
    read: async (expected) => {
      const value = await Effect.runPromise(state.getOutput(target));
      if (value === undefined) return undefined;
      if (Schema.is(legacy)(value)) {
        if (value.complete) return undefined;
        throw provisioningRefusal(
          "provisioning-prior-release-unsettled",
          "journal.legacy.complete",
          true,
          false,
        );
      }
      const saved = readRuntimeProvisioningHeader(value, key);
      if (!saved)
        throw provisioningRefusal(
          "provisioning-journal-unsupported",
          "journal.kind",
          "runtime-provisioning",
          "unsupported",
        );
      if (
        saved.record.complete &&
        (saved.record.candidate !== expected.candidate ||
          saved.record.manifest !== expected.manifest)
      )
        return undefined;
      return saved.record;
    },
    write: async (record) => {
      const current = await Effect.runPromise(state.getOutput(target));
      const prior = readRuntimeProvisioningHeader(current, key);
      const same =
        prior &&
        prior.record.candidate === record.candidate &&
        prior.record.manifest === record.manifest;
      const previous = same ? prior.header.previous : current;
      if (prior && !same && !prior.record.complete)
        throw provisioningRefusal(
          "provisioning-prior-release-unsettled",
          "journal.complete",
          true,
          false,
        );
      await Effect.runPromise(
        state.setOutput({
          ...target,
          value: {
            schemaVersion: 2,
            kind: "runtime-provisioning",
            candidate: record.candidate,
            manifest: record.manifest,
            complete: record.complete,
            sealed: sealRecovery(record, key, record.candidate, record.manifest),
            ...(previous === undefined ? {} : { previous }),
          },
        }),
      );
    },
  };
}
