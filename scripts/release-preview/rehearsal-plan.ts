import type { RehearsalScenario } from "./rehearsal-stage.ts";
import type { RehearsalStop } from "../release-barrier/release-stage.ts";
import type { RestartResult } from "./rehearsal-restart-plan.ts";

export type ReleaseOutcome = { ok: true } | { ok: false; reason: string; worker?: string };
export type ReleaseRequest = {
  candidate: "previous" | "candidate";
  stop?: RehearsalStop;
  /** A later candidate commit in the candidate checkout, for releases after the first. */
  commit?: string;
  drainCapMs?: number;
  cleanPool: string;
};
export type Wait = { name: string; outcome: string; milliseconds: number };
export type Traffic = { stop(): Promise<{ ok: number; failed: number }> };

export interface RehearsalHooks {
  /** The previous candidate's stack, deployed the ordinary way: the legacy root runtime. */
  deployBaseline(): Promise<void>;
  /** Provider accounts plus pools shaped like production's policies; returns the clean pool. */
  seedPools(): Promise<{ cleanPool: string }>;
  release(request: ReleaseRequest): Promise<ReleaseOutcome>;
  /** Refuses unless the stopped previous release left production's adopted selection and policies. */
  verifyAdopted(cleanPool: string): Promise<void>;
  /** Settles the stopped previous candidate the way production does before its next release. */
  settle(): Promise<void>;
  /** Opens one connection on the serving runtime that stays open until closed. */
  holdConnection(cleanPool: string): Promise<{ close(): Promise<void> }>;
  startTraffic(cleanPool: string): Traffic;
  waits(): Promise<Wait[]>;
  serve(): Promise<unknown>;
  /** Restarts the serving runtime once through the controller and proves serving continued. */
  restart(): Promise<RestartResult>;
}

export type RehearsalRecord = {
  scenario: RehearsalScenario;
  releases: Array<ReleaseRequest & { outcome: ReleaseOutcome }>;
  traffic: { ok: number; failed: number };
  waits: Wait[];
  restart?: RestartResult;
};

const drainCapMs = 120_000;

function expectRefusal(outcome: ReleaseOutcome, reason: string, worker?: string) {
  if (outcome.ok || outcome.reason !== reason || (worker !== undefined && outcome.worker !== worker))
    throw new Error(`The rehearsal expected the release to stop at ${reason}`);
}

function expectComplete(outcome: ReleaseOutcome) {
  if (!outcome.ok) throw new Error(`The rehearsed release refused: ${outcome.reason}`);
}

/**
 * The deploy and seed halves leave the stack where production stands: a legacy root, seven
 * policies and a previous candidate adopted at epoch 1 whose image phases never ran.
 */
export function rehearsalSteps(scenario: RehearsalScenario, hooks: RehearsalHooks) {
  const record: RehearsalRecord = {
    scenario,
    releases: [],
    traffic: { ok: 0, failed: 0 },
    waits: [],
  };
  let cleanPool = "";
  const release = async (request: ReleaseRequest) => {
    const outcome = await hooks.release(request);
    record.releases.push({ ...request, outcome });
    return outcome;
  };
  return {
    record,
    deploy: () => hooks.deployBaseline(),
    seed: async () => {
      ({ cleanPool } = await hooks.seedPools());
      expectRefusal(
        await release({ candidate: "previous", stop: "after-adopt", cleanPool }),
        "release-rehearsal-stopped-after-adopt",
      );
      await hooks.verifyAdopted(cleanPool);
      await hooks.settle();
    },
    smoke: async () => {
      // Requests run through every phase, so the capacity and drain waits see real leases.
      const traffic = hooks.startTraffic(cleanPool);
      try {
        if (scenario === "straight") {
          expectComplete(await release({ candidate: "candidate", cleanPool }));
        } else {
          const held = await hooks.holdConnection(cleanPool);
          let closed = false;
          try {
            expectRefusal(
              await release({ candidate: "candidate", drainCapMs, cleanPool }),
              "runtime-release-observation-deadline",
              "PoolWorker.old-generation-drain",
            );
            await held.close();
            closed = true;
            expectComplete(await release({ candidate: "candidate", cleanPool }));
          } finally {
            if (!closed) await held.close();
          }
        }
      } finally {
        record.traffic = await traffic.stop();
      }
      if (record.traffic.failed !== 0 || record.traffic.ok === 0)
        throw new Error("Requests through the rehearsal pool failed during the release");
      record.waits = await hooks.waits();
      if (!record.waits.some((wait) => wait.name === "old-generation-drain" && wait.outcome === "observed"))
        throw new Error("The rehearsal did not observe the old-generation drain");
      const served = await hooks.serve();
      record.restart = await hooks.restart();
      return served;
    },
  };
}

export type RehearsalReceipt = {
  version: 1;
  candidate: string;
  previous: string;
  stage: string;
  scenario: RehearsalScenario;
  releases: RehearsalRecord["releases"];
  traffic: RehearsalRecord["traffic"];
  waits: Wait[];
  restart: RestartResult;
  serving: true;
  teardown: true;
};

export function rehearsalReceipt(
  record: RehearsalRecord,
  identity: { candidate: string; previous: string; stage: string },
  teardown: boolean,
): RehearsalReceipt {
  if (!/^[a-f0-9]{40}$/u.test(identity.candidate) || !/^[a-f0-9]{40}$/u.test(identity.previous))
    throw new Error("A rehearsal receipt requires exact candidate and previous commits");
  if (!teardown) throw new Error("Rehearsal resource teardown has not been verified");
  const { releases, traffic, waits, scenario, restart } = record;
  if (!restart) throw new Error("The rehearsal did not restart the serving runtime");
  return { version: 1, ...identity, scenario, releases, traffic, waits, restart, serving: true, teardown: true };
}
