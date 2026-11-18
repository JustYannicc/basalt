/**
 * The container restart check follows the production restart proof. Load rises until the fleet has
 * a ready sibling, the controller crashes the serving runtime, and serving must continue through
 * the sibling until a new boot is ready. The crash itself is refused without that spare capacity.
 */
export type SlotIdentity = { instanceId: string; bootId: string; [field: string]: unknown };
export type Observation = {
  selection?: { active?: { identity?: SlotIdentity; target?: { instanceId?: string } } } | null;
  fleet?: {
    permission?: { enabled?: boolean; configuration?: { targetActive?: number } };
    resources?: readonly {
      phase?: string;
      identity?: SlotIdentity;
      target?: { instanceId?: string };
      active?: number;
    }[];
  };
  activeHealth?: { identity?: SlotIdentity | null; leaseMs?: number } | null;
};
export type Request = { ok: boolean; startedAt: number; endedAt: number };

export class RestartRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Rehearsal restart check refused: ${reason}`);
    this.reason = reason;
  }
}

export const restartPlan = {
  levels: [1, 2, 4, 8],
  stepMs: 60_000,
  siblingObserves: 3,
  siblingWaitMs: 360_000,
  recoveryBoundMs: 200_000,
  pollMs: 5_000,
};

const same = (left?: SlotIdentity | null, right?: SlotIdentity | null) =>
  !!left && !!right && left.instanceId === right.instanceId && left.bootId === right.bootId;

/** The controller's own choice: ready, identified, another instance, below the fleet's target. */
export function readySibling(observation: Observation, active: SlotIdentity) {
  const targetActive = observation.fleet?.permission?.configuration?.targetActive;
  if (observation.fleet?.permission?.enabled !== true || !(typeof targetActive === "number" && targetActive > 0))
    throw new RestartRefusal("baseline-fleet-policy");
  return (observation.fleet.resources ?? []).some(
    (row) =>
      row.phase === "ready" &&
      !!row.identity &&
      (row.target?.instanceId ?? row.identity.instanceId) !== active.instanceId &&
      typeof row.active === "number" &&
      row.active < targetActive,
  );
}

export interface RestartDependencies {
  observe(): Promise<Observation>;
  setConcurrency(workers: number): void;
  requests(): readonly Request[];
  crash(identity: SlotIdentity): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type RestartResult = {
  cellConcurrency: number;
  siblingObserves: number;
  signalToReadyMs: number;
  servedWhileDown: number;
  failedRequests: number;
};

export async function runRestartCheck(deps: RestartDependencies, plan = restartPlan): Promise<RestartResult> {
  const baseline = await deps.observe();
  const active = baseline.selection?.active?.identity;
  if (!active || !same(baseline.activeHealth?.identity, active) || !((baseline.activeHealth?.leaseMs ?? 0) > 0))
    throw new RestartRefusal("baseline-active-health");
  let cellConcurrency = 0;
  let siblingObserves = 0;
  for (const level of plan.levels) {
    deps.setConcurrency(level);
    await deps.sleep(plan.stepMs);
    siblingObserves += 1;
    if (readySibling(await deps.observe(), active)) {
      cellConcurrency = level;
      break;
    }
  }
  // At the highest load, wait as the production proof does before calling capacity missing.
  for (let observe = 1; !cellConcurrency && observe < plan.siblingObserves; observe += 1) {
    await deps.sleep(plan.siblingWaitMs / (plan.siblingObserves - 1));
    siblingObserves += 1;
    if (readySibling(await deps.observe(), active)) cellConcurrency = plan.levels.at(-1)!;
  }
  if (!cellConcurrency) throw new RestartRefusal("baseline-sibling-capacity");
  const signal = deps.now();
  await deps.crash(active);
  for (;;) {
    await deps.sleep(plan.pollMs);
    const now = deps.now();
    const observation = await deps.observe().catch(() => undefined);
    const fresh = observation?.selection?.active?.identity;
    if (
      fresh &&
      !same(fresh, active) &&
      same(observation.activeHealth?.identity, fresh) &&
      (observation.activeHealth?.leaseMs ?? 0) > 0
    ) {
      const during = deps.requests().filter((request) => request.ok && request.startedAt >= signal && request.endedAt <= now);
      if (during.length === 0) throw new RestartRefusal("no-service-while-primary-down");
      return {
        cellConcurrency,
        siblingObserves,
        signalToReadyMs: now - signal,
        servedWhileDown: during.length,
        failedRequests: deps.requests().filter((request) => !request.ok).length,
      };
    }
    if (now - signal > plan.recoveryBoundMs) throw new RestartRefusal("recovery-bound");
  }
}
