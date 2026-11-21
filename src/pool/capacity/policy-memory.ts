/** Per cohort, per account reference: each revision seen since the cohort last restarted. */
export type PolicyMemory = Record<string, Record<string, Record<string, number>>>;

interface Member {
  readonly group: string;
  readonly account: string;
  readonly revision: string;
}

/**
 * A cohort restarts only when a member brings a revision it has not had since the cohort's last
 * restart. Joining, leaving, or returning at a known revision is membership, not a policy change,
 * so an account moving between unit cohorts as a calibration forms and lapses keeps both trained.
 */
export function policyChanges(input: {
  readonly memory: PolicyMemory;
  readonly current: Iterable<Member>;
  readonly at: number;
  readonly keepFrom: number;
}): { changed: Set<string>; memory: PolicyMemory } {
  const changed = new Set<string>();
  const current = new Map<string, Map<string, Set<string>>>();
  for (const member of input.current) {
    const accounts = current.get(member.group) ?? new Map<string, Set<string>>();
    accounts.set(member.account, (accounts.get(member.account) ?? new Set()).add(member.revision));
    current.set(member.group, accounts);
  }
  for (const [group, accounts] of current)
    for (const [account, revisions] of accounts) {
      const known = input.memory[group]?.[account];
      if (known && [...revisions].some((revision) => known[revision] === undefined))
        changed.add(group);
    }
  const memory: PolicyMemory = {};
  for (const [group, accounts] of Object.entries(input.memory)) {
    if (changed.has(group)) continue;
    for (const [account, revisions] of Object.entries(accounts))
      for (const [revision, seen] of Object.entries(revisions))
        if (seen >= input.keepFrom) ((memory[group] ??= {})[account] ??= {})[revision] = seen;
  }
  for (const [group, accounts] of current)
    for (const [account, revisions] of accounts)
      for (const revision of revisions)
        ((memory[group] ??= {})[account] ??= {})[revision] = input.at;
  return { changed, memory };
}

/**
 * Indexes written before the memory existed keep their old rule for the one snapshot that
 * migrates them: a cohort restarts when its revision set differs from the recorded one, or when
 * it has no record. The memory then starts from the current members.
 */
export function migratePolicies(input: {
  readonly recorded: Readonly<Record<string, { revision: string }>> | undefined;
  readonly prior: Iterable<Member>;
  readonly current: Iterable<Member>;
  readonly at: number;
}): { changed: Set<string>; memory: PolicyMemory } {
  const sets = (members: Iterable<Member>) => {
    const groups = new Map<string, Set<string>>();
    for (const member of members)
      groups.set(member.group, (groups.get(member.group) ?? new Set()).add(member.revision));
    return new Map(
      [...groups].map(([group, values]) => [group, JSON.stringify([...values].sort())]),
    );
  };
  const recorded = input.recorded
    ? new Map(Object.entries(input.recorded).map(([group, policy]) => [group, policy.revision]))
    : sets(input.prior);
  const current = [...input.current];
  const changed = new Set(
    [...sets(current)]
      .filter(([group, revisions]) => recorded.get(group) !== revisions)
      .map(([group]) => group),
  );
  return {
    changed,
    memory: policyChanges({ memory: {}, current, at: input.at, keepFrom: -Infinity }).memory,
  };
}
