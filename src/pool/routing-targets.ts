/** Fluid counterpart of the carried quota-deadline selector; conformance fixtures guard both ports. */
export interface DeadlineBudget {
  readonly id: string;
  readonly remaining: number;
  readonly full: number;
  readonly resetAt: number;
  readonly short?: {
    readonly remaining: number;
    readonly resetAt: number;
    readonly mode: "fixed" | "rolling";
  };
}

export interface DeadlineTargetsInput {
  readonly now: number;
  readonly accounts: readonly DeadlineBudget[];
  readonly demandUntil: (from: number, to: number, window: "weekly" | "five-hour") => number | null;
  readonly shortFull: ReadonlyMap<string, number>;
  readonly useDemand: boolean;
}

export function quotaDeadlineTargets(input: DeadlineTargetsInput): ReadonlyMap<string, number> {
  const { now, accounts } = input;
  if (!accounts.length) return new Map();
  const deadline = Math.min(...accounts.map((account) => account.resetAt));
  const raw = new Map(
    accounts.map((account) => [
      account.id,
      account.remaining / account.full / Math.max((account.resetAt - now) / 1000, 60),
    ]),
  );
  const predicted = input.useDemand ? input.demandUntil(now, deadline, "weekly") : null;
  if (predicted !== null && predicted > 0) {
    const due = accounts
      .filter((account) => account.resetAt === deadline)
      .reduce((sum, account) => sum + account.remaining, 0);
    const early = Math.min(1, due / predicted);
    const later = accounts
      .filter((account) => account.resetAt !== deadline)
      .reduce((sum, account) => sum + raw.get(account.id)! * account.full, 0);
    for (const account of accounts)
      raw.set(
        account.id,
        account.resetAt === deadline
          ? ((later === 0 ? 1 : early) * account.remaining) / due
          : ((1 - early) * raw.get(account.id)! * account.full) / later,
      );
    const caps = new Map<string, number>();
    for (const account of accounts) {
      if (account.short?.mode !== "fixed") {
        caps.clear();
        break;
      }
      const demand = input.demandUntil(now, Math.min(deadline, account.short.resetAt), "five-hour");
      if (demand === null || demand <= 0 || !input.shortFull.has(account.id)) {
        caps.clear();
        break;
      }
      caps.set(account.id, Math.min(1, account.short.remaining / demand));
    }
    if (
      caps.size === accounts.length &&
      [...caps.values()].reduce((sum, cap) => sum + cap, 0) >= 1 - 1e-9
    )
      pace(raw, caps);
  }
  const total = [...raw.values()].reduce((sum, weight) => sum + weight, 0);
  return new Map(
    [...raw].map(([id, weight]) => [id, total > 0 ? weight / total : 1 / accounts.length]),
  );
}

function pace(weights: Map<string, number>, caps: ReadonlyMap<string, number>) {
  const pending = new Set(weights.keys());
  let left = 1;
  while (pending.size) {
    const total = [...pending].reduce((sum, id) => sum + weights.get(id)!, 0);
    const proposed = (id: string) =>
      total > 0 ? (left * weights.get(id)!) / total : left / pending.size;
    const over = [...pending].filter((id) => proposed(id) > caps.get(id)! + 1e-9);
    if (!over.length) {
      const final = [...pending].map((id) => [id, proposed(id)] as const);
      for (const [id, share] of final) weights.set(id, share);
      return;
    }
    for (const id of over) {
      weights.set(id, caps.get(id)!);
      left -= caps.get(id)!;
      pending.delete(id);
    }
  }
}
