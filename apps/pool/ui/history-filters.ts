import type { SeriesGroup, UsageSeriesMember } from "../usage-series-contract.ts";
import type { HistoryDateFilter, PublicHistoryRecord } from "./history-model.ts";
import type { MemberDirectoryEntry } from "./series-model.ts";

/** What History can narrow by from its own address: a lab, failed requests and UTC dates. */
export interface HistoryFilters {
  readonly lab?: string;
  readonly failed?: true;
  readonly dates: HistoryDateFilter;
}

const day = /^\d{4}-\d{2}-\d{2}$/u;
const lab = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Parses only the filters History supports; anything else in the address is ignored. */
export function parseHistoryFilters(search: string): HistoryFilters {
  const params = new URLSearchParams(search);
  const value = (name: string, pattern: RegExp) => {
    const text = params.get(name);
    return text !== null && pattern.test(text) ? text : undefined;
  };
  const from = value("from", day);
  const to = value("to", day);
  const provider = value("lab", lab);
  return {
    ...(provider === undefined ? {} : { lab: provider }),
    ...(params.get("status") === "failed" ? { failed: true as const } : {}),
    dates: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
  };
}

export const hasNarrowing = (filters: HistoryFilters) =>
  filters.lab !== undefined || filters.failed === true;

export const matchesRecord = (filters: HistoryFilters, record: PublicHistoryRecord) =>
  (filters.lab === undefined || record.provider === filters.lab) &&
  (filters.failed !== true || record.failed);

export const matchesGroup = (filters: HistoryFilters, group: SeriesGroup) =>
  filters.lab === undefined || group.key.provider === filters.lab;

/**
 * Names for people the host lists as current pool members. Its `active` means current access; here
 * `active` means made a request in these groups, so it is recomputed, never copied.
 */
export function historyMembers(
  members: readonly UsageSeriesMember[] | undefined,
  groups: readonly SeriesGroup[],
): MemberDirectoryEntry[] {
  const requested = new Set(
    groups.flatMap((group) =>
      typeof group.key.person === "string" && group.buckets.some((bucket) => bucket.requests > 0)
        ? [group.key.person]
        : [],
    ),
  );
  return (members ?? []).map((member) => ({
    person: member.person,
    displayName: member.displayName,
    active: requested.has(member.person),
  }));
}

/**
 * The matching page Next lands on: the following page only once its matches are loaded. Otherwise
 * the current page stays, now showing any matches the extra reads found.
 */
export const nextMatchPage = (matches: number, page: number, size: number) =>
  matches > (page + 1) * size ? page + 1 : page;
