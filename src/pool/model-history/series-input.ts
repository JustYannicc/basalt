import { digest } from "../backend-users.ts";
import { fail } from "../json.ts";
import { historyObject, invalidHistory, timestamp } from "./record.ts";
import {
  seriesDimensions,
  type PoolUsageSeriesInput,
  type SeriesAuthority,
  type SeriesDimension,
} from "./series-contract.ts";
import { homeAccountMappingProven } from "./series-mapping.ts";

export const maxSeriesRows = 5_000;
export const maxSeriesGroups = 500;
export const maxSeriesBytes = 1_048_576;
const day = 86_400_000_000_000n;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,511}$/.test(value);
export const seriesIds = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    !value.every(id) ||
    new Set(value).size !== value.length
  )
    return invalidHistory();
  return value as string[];
};
export const nanos = (at: string) => {
  const utc = timestamp(at);
  return BigInt(Date.parse(`${utc.slice(0, 19)}Z`)) * 1_000_000n + BigInt(utc.slice(20, 29));
};

/** Keep the caller's bounds for the response, and canonical UTC values for SQL and cursors. */
export function seriesInput(raw: unknown): PoolUsageSeriesInput {
  const value = historyObject(raw);
  const by = value.by;
  if (
    !id(value.pool) ||
    (value.bucket !== "hour" && value.bucket !== "day") ||
    !Array.isArray(by) ||
    by.some((key) => !seriesDimensions.includes(key)) ||
    new Set(by).size !== by.length
  )
    return invalidHistory();
  const from = timestamp(value.from),
    to = timestamp(value.to);
  if (from >= to || nanos(to) - nanos(from) > 400n * day) return invalidHistory();
  const input: PoolUsageSeriesInput = {
    pool: value.pool,
    from: String(value.from),
    to: String(value.to),
    bucket: value.bucket,
    by: seriesDimensions.filter((key) => by.includes(key)),
  };
  if (value.accounts !== undefined) input.accounts = seriesIds(value.accounts);
  if (value.sources !== undefined) {
    input.sources = seriesIds(value.sources);
    if (!input.sources.every((source) => /^[a-f0-9]{64}$/.test(source))) return invalidHistory();
  }
  if (value.window !== undefined) {
    const window = historyObject(value.window);
    const start = timestamp(window.from),
      end = timestamp(window.to);
    if (start >= end || start >= to || end <= from) return invalidHistory();
    input.window = { from: String(window.from), to: String(window.to) };
  }
  if (value.after !== undefined) {
    if (typeof value.after !== "string" || value.after.length > 8_192) return invalidHistory();
    input.after = value.after;
  }
  return input;
}

export function seriesBounds(input: PoolUsageSeriesInput) {
  const from = timestamp(input.from),
    to = timestamp(input.to);
  const start = input.window ? timestamp(input.window.from) : from;
  const end = input.window ? timestamp(input.window.to) : to;
  return { from: from > start ? from : start, to: to < end ? to : end };
}

/** Only signed host assertions supply account bindings. The API caller cannot choose this authority. */
export function seriesAuthority(raw: unknown): SeriesAuthority {
  const value = historyObject(raw);
  if (value.canManage !== true)
    return fail(403, "unauthorized", "Only a pool manager can read usage series.");
  if (!Array.isArray(value.accounts) || value.accounts.length > 500) return invalidHistory();
  return {
    canManage: true,
    mappingProven: homeAccountMappingProven,
    accounts: value.accounts.map((raw) => {
      const account = historyObject(raw);
      if (account.account !== null && !id(account.account)) return invalidHistory();
      const history = seriesIds(account.history);
      if (history.length > 32 || !history.every((ref) => /^[a-f0-9]{64}$/.test(ref)))
        return invalidHistory();
      return { account: account.account as string | null, history };
    }),
  };
}

export function authorizeSeries(
  input: Pick<PoolUsageSeriesInput, "accounts">,
  authority: SeriesAuthority,
) {
  if (!authority.canManage)
    return fail(403, "unauthorized", "Only a pool manager can read usage series.");
  const visible = new Set(
    authority.accounts.flatMap((entry) => (entry.account === null ? [] : [entry.account])),
  );
  if (input.accounts?.some((account) => !visible.has(account)))
    return fail(403, "unauthorized", "You cannot inspect one of the requested accounts.");
}

export interface SeriesCursor {
  key: string;
  at: string;
}
export async function cursorScope(input: PoolUsageSeriesInput, authority: SeriesAuthority) {
  const { after: _, ...query } = input;
  return digest(JSON.stringify([query, authority]));
}
export function readSeriesCursor(
  raw: string | undefined,
  scope: string,
  by: readonly SeriesDimension[],
): SeriesCursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = historyObject(JSON.parse(raw));
  if (cursor.scope !== scope || typeof cursor.key !== "string" || cursor.key.length > 4_096)
    return invalidHistory();
  const key = historyObject(JSON.parse(cursor.key));
  const names = Object.keys(key).sort();
  const redactedNames = [
    ...new Set(["account", "currency", ...by, ...(by.includes("person") ? ["attribution"] : [])]),
  ].sort();
  const redacted =
    key.currency === null &&
    (key.account === "otherAccounts" || key.account === "unmapped") &&
    JSON.stringify(names) === JSON.stringify(redactedNames) &&
    Object.entries(key).every(([name, value]) => name === "account" || value === null);
  const required = [
    ...new Set(["currency", ...by, ...(by.includes("person") ? ["attribution"] : [])]),
  ].sort();
  if (
    (!redacted && JSON.stringify(names) !== JSON.stringify(required)) ||
    Object.values(key).some((value) => value !== null && typeof value !== "string")
  )
    return invalidHistory();
  return { key: cursor.key, at: timestamp(cursor.at) };
}
export function writeSeriesCursor(scope: string, key: string, at: string) {
  return JSON.stringify({ scope, key, at });
}
export function successRate(requests: number, failed: number) {
  return requests === 0 ? null : (requests - failed) / requests;
}
