import { join } from "node:path";
import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import type { Effect } from "effect";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { PreflightBridgeCounters } from "./release-preflight-guard.ts";
import {
  preflightRefusal,
  type SettlementProofOutcome,
  type SettlementProofReads,
} from "./release-preflight.ts";
import type { RehearsalCounters } from "./release-resume-rehearsal.ts";
import type { ReleaseSettlementDisposition } from "./release-settlement-contract.ts";
import { assertReleaseSettlementArchiveAbsent } from "./release-settlement-operation.ts";
import {
  collectReleaseSettlementProof,
  settlementSourceActivated,
  type ReleaseSettlementIo,
} from "./release-settlement-proof.ts";
import { BarrierRefusal } from "./refusal.ts";

/** Cloudflare readers the proof would otherwise reach through the guarded fetch; tests replace them. */
export type PreflightSettlementIo = Omit<ReleaseSettlementIo, "connect" | "runtimeRead">;

function readsSince(
  counters: RehearsalCounters | undefined,
  bridge: PreflightBridgeCounters,
): () => SettlementProofReads {
  const state = counters && { ...counters.state };
  const http = counters && { ...counters.fetch };
  const dispatched = { ...bridge.dispatched };
  return () => ({
    state:
      counters && state
        ? {
            get: counters.state.get - state.get,
            getOutput: counters.state.getOutput - state.getOutput,
            writeAttempts: counters.state.writeAttempts - state.writeAttempts,
          }
        : null,
    http:
      counters && http
        ? {
            providerGets: counters.fetch.providerGetAttempts - http.providerGetAttempts,
            stateGets: counters.fetch.stateGetAttempts - http.stateGetAttempts,
            blockedMutations: counters.fetch.blockedMutationAttempts - http.blockedMutationAttempts,
          }
        : null,
    bridge: Object.fromEntries(
      Object.entries(bridge.dispatched)
        .map(([action, count]) => [action, count - (dispatched[action] ?? 0)] as const)
        .filter(([, count]) => count > 0),
    ),
  });
}

/**
 * Collects the plan's own settlement proof for the unsettled prior, read-only, so a Check shows
 * whether this candidate's plan would accept it. Every client is the preflight's: `read` provides
 * the write-denied, counted State service; Cloudflare reads go through the guarded,
 * mutation-counting probe fetch the entry installs as both global fetch and HttpClient; and
 * `connect` is the readOnlyPoolOperations bridge, which refuses any handoff action outside
 * preflightReadActions before sending it. No archive, intent or plan is written.
 */
export async function preflightSettlementProof(input: {
  compiled: CompiledStack;
  state: StateService;
  read: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  candidate: string;
  prior: string;
  disposition: ReleaseSettlementDisposition;
  /** The code the live controller accepted; a controller-active source must be running it. */
  liveCode: typeof ControllerCode.Type;
  accountId: string;
  encryptionKey: string;
  directory: string;
  connect: NonNullable<PoolOperationsTarget["connect"]>;
  bridge: PreflightBridgeCounters;
  counters?: RehearsalCounters;
  io?: PreflightSettlementIo;
}): Promise<SettlementProofOutcome> {
  const { disposition, prior: source } = input;
  // Only a controller-active source names a controller: the one the live inspect accepted. The
  // proof itself refuses one that is not the prior candidate's.
  const sourceController = settlementSourceActivated(disposition) ? input.liveCode : undefined;
  const reads = readsSince(input.counters, input.bridge);
  try {
    await input.read(
      assertReleaseSettlementArchiveAbsent(input.state, input.compiled, source, input.candidate),
    );
    const { proof } = await input.read(
      collectReleaseSettlementProof(
        input.compiled,
        source,
        input.encryptionKey,
        // An abandoned source's dry-run forward resume writes its local receipts here, apart from
        // the preflight report.
        join(input.directory, "settlement-proof"),
        { ...input.io, connect: input.connect },
        disposition,
        sourceController,
      ),
    );
    if (proof.controller.target.accountId !== input.accountId)
      throw new BarrierRefusal("release-settlement-account-refused", "PoolWorker");
    return {
      status: "accepted",
      disposition,
      source,
      controller: proof.controller.code.candidate,
      reads: reads(),
    };
  } catch (error) {
    return {
      status: "refused",
      disposition,
      source,
      refusal: preflightRefusal(error),
      reads: reads(),
    };
  }
}
