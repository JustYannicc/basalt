import { Effect, Schema } from "effect";
import type { SlotIdentity } from "../../src/pool/runtime-slots/contract.ts";
import {
  crashCell,
  inspectCrash,
  inspectFleet,
  shortHash,
  type ControllerAccess,
} from "./controller.ts";
import { refuse, type FleetLaneRefused } from "./errors.ts";
import { selectedPrimary } from "./operations.ts";

/**
 * About one request a second through the public pool, stopped by the proof or at `boundMs`,
 * whichever comes first, so a proof that waits longer never keeps spending real accounts.
 */
export function requestLoop(input: {
  request: (index: number) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  boundMs: number;
}) {
  const outcomes: { startedAt: number; ok: boolean }[] = [];
  let running = true;
  const started = input.now();
  const loop = (async () => {
    for (let index = 0; running && input.now() - started < input.boundMs; index++) {
      const startedAt = input.now();
      const ok = await input.request(index).then(
        () => true,
        () => false,
      );
      outcomes.push({ startedAt, ok });
      await input.sleep(1_000);
    }
  })();
  return {
    outcomes,
    // Settles when the loop ends, by stop() or at its bound.
    done: loop,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

const call = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });
const same = (left: SlotIdentity | undefined, right: SlotIdentity) =>
  left?.instanceId === right.instanceId && left.bootId === right.bootId;
const Submission = Schema.Struct({
  result: Schema.Struct({ submission: Schema.NullOr(Schema.Unknown) }),
});

export interface CrashInput {
  controller: ControllerAccess;
  go: string;
  operator: string;
  /** One request through the public pool API; the loop numbers them so callers can vary the kind. */
  request: (index: number) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  detectBoundMs?: number;
  restartBoundMs?: number;
  /** When the request loop stops even if the proof still waits. */
  trafficBoundMs?: number;
  /** Checked just before the kill: a run that can no longer test anything kills no cell. */
  halted?: () => FleetLaneRefused | undefined;
}

/**
 * The production restart proof (R3): hard-kill one ready cell that is not the primary while a
 * request loop runs. The cell refuses in-process when its Home is the elected master.
 */
export const crashReadyCell = (input: CrashInput) =>
  Effect.gen(function* () {
    const { controller: access, now } = input;
    const detectBound = input.detectBoundMs ?? 60_000,
      restartBound = input.restartBoundMs ?? 300_000;
    const nonce = `cell-${shortHash("crash", input.go)}`;
    const primary = yield* selectedPrimary(access);
    // The submission is keyed by nonce alone, so a rerun reads it before choosing any target.
    const prior = Schema.decodeUnknownSync(Submission)(
      yield* call(() => inspectCrash(access, primary, nonce)),
    ).result.submission;
    if (prior !== null) return { status: "already-submitted" as const, nonce };
    const fleet = yield* call(() => inspectFleet(access));
    const targetActive = fleet.permission?.configuration.targetActive ?? 0;
    // A cell takes calls while it is ready and not fenced by a read that wasn't good.
    const cells = (rows: typeof fleet.resources) =>
      rows.filter(
        (row) =>
          row.phase === "ready" &&
          row.suspect === undefined &&
          row.identity &&
          row.target.instanceId !== primary.instanceId,
      );
    const ready = cells(fleet.resources).filter((row) => row.active < targetActive);
    if (!fleet.permission?.enabled || !ready.length)
      return yield* Effect.fail(
        refuse(
          "no-ready-cell",
          `fleet enabled=${fleet.permission?.enabled ?? "absent"}, ready non-primary cells below targetActive=${ready.length}; the crash proof needs one.`,
          "Run configure-and-accept first, or send traffic so a cell starts, then rerun.",
        ),
      );
    const target = ready[0]!.identity!;
    const before = cells(fleet.resources).length;
    const loop = requestLoop({ ...input, boundMs: input.trafficBoundMs ?? 330_000 });
    const { outcomes } = loop;
    const stop = Effect.promise(loop.stop);
    const proof = Effect.gen(function* () {
      yield* call(() => input.sleep(3_000));
      const halt = input.halted?.();
      if (halt) return yield* Effect.fail(halt);
      yield* call(() => crashCell(access, target, nonce, input.operator));
      const killedAt = now();
      let detectedMs: number | undefined;
      while (true) {
        const rows = (yield* call(() => inspectFleet(access))).resources;
        const elapsed = now() - killedAt;
        const live = cells(rows);
        if (detectedMs === undefined && !live.some((row) => same(row.identity, target)))
          detectedMs = elapsed;
        if (
          detectedMs !== undefined &&
          live.filter((row) => !same(row.identity, target)).length >= before
        )
          return { killedAt, detectedMs, restartedMs: elapsed };
        if (detectedMs === undefined && elapsed > detectBound)
          return yield* Effect.fail(
            refuse(
              "crash-not-detected",
              `The killed cell still reads ready ${Math.round(elapsed / 1000)} s after the crash (bound ${detectBound / 1000} s).`,
              "Read runtime-crash-inspect with the same GO and the cell's PoolRuntime logs.",
            ),
          );
        if (elapsed > restartBound)
          return yield* Effect.fail(
            refuse(
              "cell-not-restarted",
              `${live.length} ready cells ${Math.round(elapsed / 1000)} s after the crash; ${before} were ready before (bound ${restartBound / 1000} s).`,
              "Read fleet-inspect rows and the replacement for the killed cell.",
            ),
          );
        yield* call(() => input.sleep(2_000));
      }
    });
    const measured = yield* Effect.ensuring(proof, stop);
    const after = outcomes.filter((outcome) => outcome.startedAt >= measured.killedAt);
    const failedAfter = after.filter((outcome) => !outcome.ok).length;
    // Requests in flight on the killed cell may be cut; they are reported, not counted as a failure.
    const failedInFlight = outcomes.filter(
      (outcome) => !outcome.ok && outcome.startedAt < measured.killedAt,
    ).length;
    if (failedAfter)
      return yield* Effect.fail(
        refuse(
          "requests-failed-after-crash",
          `${failedAfter} of ${after.length} requests started after the crash reply failed.`,
          "Traffic did not move to the primary and the other cells; read the PoolWorker logs.",
        ),
      );
    return {
      status: "proven" as const,
      nonce,
      // The killed cell and when its kill was answered (this runner's clock), so a reader can tell a call
      // cut on that cell from one cut anywhere else. Ids only: no host, account or key.
      target: { slotId: target.slotId, instanceId: target.instanceId, bootId: target.bootId },
      killedAt: measured.killedAt,
      detectedMs: measured.detectedMs,
      restartedMs: measured.restartedMs,
      bounds: { detectMs: detectBound, restartMs: restartBound },
      requests: { total: outcomes.length, afterCrash: after.length, failedAfter, failedInFlight },
    };
  });
