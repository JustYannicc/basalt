import { Effect } from "effect";
import { State } from "alchemy/State/State";
import type { Fetcher } from "../deploy-safety/http.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import {
  assertFirstHandoffEnable,
  firstHandoffRuntimeEnable,
  freezeFirstHandoff,
  type FirstHandoffManifest,
} from "./first-handoff-contract.ts";
import { firstHandoffWorkerProvider } from "./first-handoff-cloudflare.ts";
import { firstHandoffRuntime } from "./first-handoff-runtime.ts";
import { activateFirstHandoff } from "./first-handoff.ts";
import { stateProvisioningStore } from "./provisioning-state.ts";
import type { ProvisioningStore } from "./provisioning-journal.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { assertRuntimeBridgeKey, assertRuntimeProofEnable } from "./runtime-slot-manifest.ts";

/** A separate exact activation decision and the release lock are required; no live entrypoint is installed. */
export const runFirstHandoff = (input: {
  manifest: FirstHandoffManifest;
  enable: ProvisioningEnable | undefined;
  lease: { id: string; exclusive: ProvisioningStore["exclusive"] };
  recoveryKey: string;
  signingKey: string;
  target: PoolOperationsTarget;
  fetcher?: Fetcher;
  now?: () => number;
}) =>
  Effect.gen(function* () {
    const manifest = freezeFirstHandoff(input.manifest);
    const now = input.now ?? Date.now;
    assertFirstHandoffEnable(manifest, input.enable, now());
    sameProvisioningValue("firstHandoff.writerLease", input.enable!.writerLease, input.lease.id);
    for (const role of ["legacy", "candidate"] as const) {
      assertRuntimeProofEnable(
        manifest[role],
        firstHandoffRuntimeEnable(manifest, role, input.enable!, now()),
        now(),
      );
      assertRuntimeBridgeKey(manifest[role], input.signingKey);
    }
    const state = yield* yield* State;
    const worker = yield* firstHandoffWorkerProvider(manifest, input.enable, now);
    const runtime = yield* firstHandoffRuntime({ ...input, manifest, enable: input.enable! });
    const store = stateProvisioningStore(
      state,
      { name: manifest.candidate.stack, stage: manifest.candidate.stage },
      input.recoveryKey,
      input.lease.exclusive,
    );
    return yield* Effect.tryPromise({
      try: () =>
        activateFirstHandoff({ manifest, enable: input.enable, store, worker, runtime, now }),
      catch: (error: unknown) => error,
    });
  });
