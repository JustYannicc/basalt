import { State, type StateService } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Effect, Schema } from "effect";
import type { CompiledStack } from "alchemy/Stack";
import type { BarrierReceipt } from "./barrier.ts";
import {
  BarrierRefusal,
  canonical,
  describeWorker,
  digest,
  type ReleaseManifest,
} from "./manifest.ts";
import { describeContainer } from "./container.ts";
import { openRecovery, sealRecovery } from "./recovery-envelope.ts";
import { encodedRecordHash, readForwardPacket, type ForwardPacket } from "./forward-model.ts";

const header = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  sealed: Schema.Unknown,
  complete: Schema.Boolean,
});
export const journalKey = (stack: Pick<CompiledStack, "name" | "stage">) => ({
  stack: `${stack.name}-release-barrier`,
  stage: stack.stage,
});
export const containerKey = (stack: Pick<CompiledStack, "name" | "stage">) => ({
  stack: stack.name,
  stage: stack.stage,
  fqn: "PoolContainer",
});

export const readForwardJournal = (stack: Pick<CompiledStack, "name" | "stage">, key: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const value = yield* state.getOutput(journalKey(stack));
    if (value === undefined) return undefined;
    const parsed = Schema.decodeUnknownSync(header)(value);
    if (parsed.complete) return { complete: true as const };
    return {
      complete: false as const,
      packet: readForwardPacket(
        openRecovery(parsed.sealed, key, parsed.candidate, parsed.manifest),
      ),
    };
  });

export const writeForwardJournal = (
  state: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
  key: string,
  packet: ForwardPacket,
  complete = false,
  adoption?: unknown,
) =>
  Effect.gen(function* () {
    const prior = yield* state.getOutput(journalKey(stack));
    const existing =
      prior === undefined
        ? undefined
        : Schema.decodeUnknownSync(
            Schema.Struct({ ...header.fields, previous: Schema.optional(Schema.Unknown) }),
          )(prior);
    const previous =
      existing?.candidate !== packet.manifest.candidate && existing
        ? {
            candidate: existing.candidate,
            manifest: existing.manifest,
            sealed: existing.sealed,
            complete: existing.complete,
          }
        : existing?.previous;
    return yield* state.setOutput({
      ...journalKey(stack),
      value: {
        schemaVersion: 1,
        candidate: packet.manifest.candidate,
        manifest: packet.receipt.manifest,
        complete,
        sealed: sealRecovery(
          { ...packet, ...(adoption ? { adoption } : {}) },
          key,
          packet.manifest.candidate,
          packet.receipt.manifest,
        ),
        ...(previous ? { previous } : {}),
      },
    });
  });

/** The separate output is durable before any activation intent or result is acknowledged. */
export const beginForwardJournal = (
  stack: Pick<CompiledStack, "name" | "stage">,
  manifest: ReleaseManifest,
  key: string,
) =>
  Effect.gen(function* () {
    if (manifest.schemaVersion !== 2) return undefined;
    const state = yield* yield* State;
    const saved = yield* state.get(containerKey(stack));
    const publicManifest = {
      schemaVersion: 2,
      candidate: manifest.candidate,
      stack: manifest.stack,
      stage: manifest.stage,
      workers: manifest.workers.map(describeWorker),
      containers: manifest.containers?.map(describeContainer),
    };
    const frozen = { ...publicManifest, containers: manifest.containers };
    const fingerprint = digest(canonical(publicManifest));
    let latest: ForwardPacket | undefined;
    return {
      record: (receipt: BarrierReceipt) =>
        Effect.gen(function* () {
          latest = readForwardPacket({
            schemaVersion: 1,
            manifest: publicManifest,
            frozen,
            receipt,
            nativeBefore: encodeState(saved),
          });
          yield* writeForwardJournal(state, stack, key, latest);
        }),
      finalizingState: {
        ...state,
        set: <V extends import("alchemy/State/State").PersistedState>(request: {
          stack: string;
          stage: string;
          fqn: string;
          value: V;
        }) =>
          Effect.gen(function* () {
            if (
              request.stack === stack.name &&
              request.stage === stack.stage &&
              request.fqn === "PoolContainer"
            ) {
              if (!latest) throw new BarrierRefusal("forward-journal-missing-final");
              const before = yield* state.get(containerKey(stack));
              const receipt = {
                before: encodedRecordHash(before),
                after: encodedRecordHash(request.value),
              };
              const backup = sealRecovery(
                {
                  schemaVersion: 1,
                  before: encodeState(before),
                  after: encodeState(request.value),
                  receipt,
                },
                key,
                latest.manifest.candidate,
                latest.receipt.manifest,
              );
              latest = { ...latest, adoption: { ...receipt, backup } };
              yield* writeForwardJournal(state, stack, key, latest);
            }
            return yield* state.set(request);
          }),
      } satisfies StateService,
      finish: () =>
        latest
          ? writeForwardJournal(state, stack, key, latest, true)
          : Effect.die(new BarrierRefusal("forward-journal-missing-final", fingerprint)),
    };
  });
