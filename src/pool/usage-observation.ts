import { hasTools } from "./computer-registry.ts";
export interface UsageObservationComputer {
  id: string;
  user: string;
  pool: string;
  createdAt: string;
  boundAt: string;
  state: "issuing" | "active" | "revoking" | "revoked" | "removed";
  keyId?: number;
  firstModelRequestAt: string | null;
  firstModelRequestEverAt?: string | null;
  modelObservationCheckedAt?: number;
  firstToolCallAt: string | null;
  toolsKeyId?: string;
  setupCompletedAt?: string | null;
}

export interface UsageObservationEvent {
  event: "first_model_request" | "setup_completed";
  accountId: string;
}

const batchSize = 10;

/** Ask Home only about active computers that have no successful model record yet. */
export async function observePendingUsage(
  registry: Record<string, UsageObservationComputer>,
  observed: (pool: string, keyId: number, since: string) => Promise<string | null>,
  now: () => number,
  filter: { user?: string; pool?: string } = {},
): Promise<UsageObservationEvent[]> {
  const computers = Object.values(registry);
  let checkedAt = computers.reduce((latest, computer) => Math.max(latest, computer.modelObservationCheckedAt ?? 0), now());
  const pending = computers
    .filter((computer) => computer.state === "active" && !computer.firstModelRequestAt && computer.keyId
      && (filter.user === undefined || computer.user === filter.user)
      && (filter.pool === undefined || computer.pool === filter.pool))
    .sort((a, b) => (a.modelObservationCheckedAt ?? 0) - (b.modelObservationCheckedAt ?? 0)
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, batchSize);

  const events: UsageObservationEvent[] = [];
  for (const computer of pending) {
    checkedAt = Math.max(checkedAt + 1, now());
    computer.modelObservationCheckedAt = checkedAt;
    let observedAt: string | null;
    try { observedAt = await observed(computer.pool, computer.keyId!, computer.boundAt); }
    catch { continue; }
    if (!observedAt) continue;

    const firstForAccount = !computers.some((row) => row.user === computer.user
      && (row.firstModelRequestEverAt || row.firstModelRequestAt));
    computer.firstModelRequestAt = observedAt;
    computer.firstModelRequestEverAt ??= observedAt;
    if (firstForAccount) events.push({ event: "first_model_request", accountId: computer.user });
    if (markSetupCompleted(computer, now)) events.push({ event: "setup_completed", accountId: computer.user });
  }
  return events;
}

export function markSetupCompleted(computer: UsageObservationComputer, now: () => number): boolean {
  // A models-only computer has no tools token, so its first model request completes setup.
  const tools = !hasTools(computer) || computer.firstToolCallAt;
  if (!computer.firstModelRequestAt || !tools || computer.setupCompletedAt) return false;
  computer.setupCompletedAt = new Date(now()).toISOString();
  return true;
}
