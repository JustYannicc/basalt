import { failedBucketWithoutUsage, noRecordedUsage } from "./usage-outcome.ts";
import type { Result } from "../control.ts";
import type { OverviewMoneyMetric, OverviewPriceProvenance } from "../overview-contract.ts";
import type {
  CostSum,
  PoolUsageSeriesInput,
  PoolUsageSeriesResult,
  SeriesBucket,
  SeriesCounts,
  SeriesCoverage,
  SeriesGroup,
  SeriesKey,
  UsageSeriesMember,
} from "../usage-series-contract.ts";

// Usage series, read the way the overview needs it: every page of one pinned query, then rolled up
// without losing precision. Token sums are integer strings and costs decimal strings, so both add up
// as BigInt; nothing here turns a missing value into zero.

export type SeriesQuery = Omit<PoolUsageSeriesInput, "pool">;
export type SeriesFetch = (input: SeriesQuery) => Promise<Result<PoolUsageSeriesResult>>;

/** The client stops after this many pages and says the result is partial. */
export const maxSeriesPages = 10;

export interface SeriesRead {
  readonly groups: readonly SeriesGroup[];
  readonly coverage: SeriesCoverage;
  /** The first page's observation time; later pages are compared against it. */
  readonly asOf: string | null;
  /** A later page saw a different observation, such as an import landing mid-read. */
  readonly asOfChanged: boolean;
  /** More pages remained after `maxSeriesPages`. */
  readonly truncated: boolean;
  /** Current pool members the host named on the first page of a person read. */
  readonly directory?: readonly UsageSeriesMember[];
}

const keyId = (key: SeriesKey) =>
  JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));

/** Reads every page of one query, pinned to the caller's bounds, merging groups split across pages. */
export async function readSeries(
  fetch: SeriesFetch,
  input: SeriesQuery,
  maxPages = maxSeriesPages,
): Promise<Result<SeriesRead>> {
  const groups = new Map<string, SeriesGroup>();
  let first: PoolUsageSeriesResult | undefined;
  let changed = false;
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetch(after === undefined ? input : { ...input, after });
    if (!result.ok) return result;
    const value = result.value;
    first ??= value;
    if (value.asOf !== first.asOf) changed = true;
    for (const group of value.groups) {
      const id = keyId(group.key);
      const known = groups.get(id);
      groups.set(id, known ? mergeGroup(known, group) : group);
    }
    if (value.next === null)
      return {
        ok: true,
        value: {
          groups: [...groups.values()],
          coverage: first.coverage,
          asOf: first.asOf,
          asOfChanged: changed,
          truncated: false,
          ...(first.directory === undefined ? {} : { directory: first.directory }),
        },
      };
    after = value.next;
  }
  // `first` is set: maxPages is at least one and every failed page returned above.
  const read = first as PoolUsageSeriesResult;
  return {
    ok: true,
    value: {
      groups: [...groups.values()],
      coverage: read.coverage,
      asOf: read.asOf,
      asOfChanged: changed,
      truncated: true,
      ...(read.directory === undefined ? {} : { directory: read.directory }),
    },
  };
}

/** One group continued on a later page; its account display rides on whichever page carried it. */
export function mergeGroup(known: SeriesGroup, next: SeriesGroup): SeriesGroup {
  const accountDisplay = known.accountDisplay ?? next.accountDisplay;
  return {
    key: known.key,
    ...(accountDisplay === undefined ? {} : { accountDisplay }),
    buckets: [...known.buckets, ...next.buckets],
  };
}

// ---------- exact decimals ----------

export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

export function decimal(text: string): Decimal | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  const units = BigInt(`${match[2]}${fraction}`);
  return { units: match[1] ? -units : units, scale: fraction.length };
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const lift = (value: Decimal) => value.units * 10n ** BigInt(scale - value.scale);
  return { units: lift(a) + lift(b), scale };
}

/** Exact text, trailing zeros trimmed: "12.5", "0.000431". */
export function decimalText(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const decimalNumber = (value: Decimal) => Number(decimalText(value));

// ---------- rollups ----------

/** One currency's priced total. Home charges and imported API prices never share one. */
export interface Money {
  readonly currency: string;
  readonly amount: Decimal;
}

export interface Totals {
  requests: number;
  failed: number;
  unassignedFailures: number;
  failedWithoutUsage: number;
  /** Requests from buckets the caller may count but not split (account mapping pending). */
  countsOnly: number;
  tokens: bigint;
  /** Requests with a token count, and without one. */
  tokensKnown: number;
  tokensMissing: number;
  home: Money[];
  homePriced: number;
  imported: Money[];
  unpriced: number;
  /** Current public USD estimate, kept apart from Home charges and historical prices. */
  apiEstimate: Estimate;
  /** A bucket in range was still filling when read. */
  partial: boolean;
}

/**
 * Rolled-up public estimate. A bucket from an older server carries no estimate at all; its requests
 * count as `notReported`, never as $0.00. `price` is the oldest rate set used, and stays marked as
 * baseline or refresh-failed if any part of the sum was.
 */
export interface Estimate {
  amount: Decimal | null;
  /** An amount failed to parse, so no sum can be trusted. */
  invalid: boolean;
  pricedRequests: number;
  unknownKind: number;
  unpriced: number;
  notReported: number;
  reasons: string[];
  price: Price | null;
}

export const emptyEstimate = (): Estimate => ({
  amount: null,
  invalid: false,
  pricedRequests: 0,
  unknownKind: 0,
  unpriced: 0,
  notReported: 0,
  reasons: [],
  price: null,
});

/**
 * Rate provenance with older-server defaults filled in. `calculation` stays optional: it is set
 * only when some records were priced from their token counts, and no default stands in for it.
 */
export type Price = Required<Omit<OverviewPriceProvenance, "calculation">> &
  Pick<OverviewPriceProvenance, "calculation">;

/** Older servers omit `basis`; they only ever returned refreshed live rates. */
export const provenance = (price: OverviewPriceProvenance): Price => ({
  ...price,
  basis: price.basis ?? "live",
  refreshFailed: price.refreshFailed ?? false,
});

export function combinePrice(a: Price | null, b: Price | null): Price | null {
  if (!a || !b) return a ?? b;
  const older = Date.parse(b.asOf) < Date.parse(a.asOf) ? b : a;
  // A sum is only as exact as its least exact part, so one counted slice marks the whole sum.
  const calculation = a.calculation ?? b.calculation;
  return {
    ...older,
    basis: a.basis === "baseline" || b.basis === "baseline" ? "baseline" : "live",
    refreshFailed: a.refreshFailed || b.refreshFailed,
    ...(calculation ? { calculation } : {}),
  };
}

function addEstimate(into: Estimate, metric: OverviewMoneyMetric) {
  into.pricedRequests += metric.pricedRequests;
  into.unknownKind += metric.excluded.unknownKind;
  into.unpriced += metric.excluded.unpriced;
  if (metric.status === "unavailable") {
    if (metric.reason && !into.reasons.includes(metric.reason)) into.reasons.push(metric.reason);
    return;
  }
  if (metric.price) into.price = combinePrice(into.price, provenance(metric.price));
  if (metric.amount === null) return;
  const amount = decimal(metric.amount);
  if (!amount) into.invalid = true;
  else into.amount = into.amount === null ? amount : addDecimal(into.amount, amount);
}

function mergeEstimate(into: Estimate, from: Estimate) {
  into.invalid ||= from.invalid;
  if (from.amount !== null)
    into.amount = into.amount === null ? from.amount : addDecimal(into.amount, from.amount);
  into.pricedRequests += from.pricedRequests;
  into.unknownKind += from.unknownKind;
  into.unpriced += from.unpriced;
  into.notReported += from.notReported;
  for (const reason of from.reasons) if (!into.reasons.includes(reason)) into.reasons.push(reason);
  into.price = combinePrice(into.price, from.price);
}

export const emptyTotals = (): Totals => ({
  requests: 0,
  failed: 0,
  unassignedFailures: 0,
  failedWithoutUsage: 0,
  countsOnly: 0,
  tokens: 0n,
  tokensKnown: 0,
  tokensMissing: 0,
  home: [],
  homePriced: 0,
  imported: [],
  unpriced: 0,
  apiEstimate: emptyEstimate(),
  partial: false,
});

function addMoney(list: Money[], sum: CostSum) {
  if (sum.amount === null || sum.currency === null) return;
  const amount = decimal(sum.amount);
  if (!amount) return;
  const index = list.findIndex((entry) => entry.currency === sum.currency);
  if (index < 0) list.push({ currency: sum.currency, amount });
  else list[index] = { currency: sum.currency, amount: addDecimal(list[index]!.amount, amount) };
}

const priced = (bucket: SeriesBucket | SeriesCounts): bucket is SeriesBucket => "tokens" in bucket;

export function addBucket(totals: Totals, bucket: SeriesBucket | SeriesCounts) {
  totals.requests += bucket.requests;
  totals.failed += bucket.failed;
  totals.unassignedFailures += bucket.unassignedFailures;
  totals.partial ||= bucket.partial;
  if (!priced(bucket)) {
    totals.countsOnly += bucket.requests;
    return;
  }
  if (failedBucketWithoutUsage(bucket)) totals.failedWithoutUsage += bucket.requests;
  const total = bucket.tokens.total;
  if (total.sum !== null && /^\d+$/.test(total.sum)) totals.tokens += BigInt(total.sum);
  totals.tokensKnown += total.known;
  totals.tokensMissing += total.missing;
  addMoney(totals.home, bucket.cost.homeCharge);
  addMoney(totals.imported, bucket.cost.importedApiPrice);
  totals.homePriced += bucket.cost.homeCharge.priced;
  totals.unpriced += bucket.cost.unpricedRequests;
  if (bucket.cost.apiEstimate) addEstimate(totals.apiEstimate, bucket.cost.apiEstimate);
  else totals.apiEstimate.notReported += bucket.requests;
}

export function addTotals(into: Totals, from: Totals) {
  into.requests += from.requests;
  into.failed += from.failed;
  into.unassignedFailures += from.unassignedFailures;
  into.failedWithoutUsage += from.failedWithoutUsage;
  into.countsOnly += from.countsOnly;
  into.tokens += from.tokens;
  into.tokensKnown += from.tokensKnown;
  into.tokensMissing += from.tokensMissing;
  for (const money of from.home)
    addMoney(into.home, {
      amount: decimalText(money.amount),
      currency: money.currency,
      priced: 0,
      unpriced: 0,
    });
  for (const money of from.imported)
    addMoney(into.imported, {
      amount: decimalText(money.amount),
      currency: money.currency,
      priced: 0,
      unpriced: 0,
    });
  into.homePriced += from.homePriced;
  into.unpriced += from.unpriced;
  mergeEstimate(into.apiEstimate, from.apiEstimate);
  into.partial ||= from.partial;
}

/**
 * Who a group belongs to. Redacted groups are accounts the caller can count but not inspect, or
 * history not yet mapped to an account; imports keep their own label and never become a person.
 */
export type Who =
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "import" }
  | { readonly kind: "unattributed" }
  | { readonly kind: "unmapped" }
  | { readonly kind: "other-accounts" };

export function who(key: SeriesKey): Who {
  if (key.account === "unmapped") return { kind: "unmapped" };
  if (key.account === "otherAccounts") return { kind: "other-accounts" };
  if (key.person) return { kind: "person", id: key.person };
  if (key.attribution === "import-owner") return { kind: "import" };
  return { kind: "unattributed" };
}

export const whoId = (value: Who) => (value.kind === "person" ? `person:${value.id}` : value.kind);

export const whoLabel = (value: Who) =>
  ({
    person: value.kind === "person" ? `Person ${value.id.slice(0, 6)}` : "",
    import: "Imported history · no person attributed",
    unattributed: "Unattributed",
    unmapped: "Not mapped to an account yet",
    "other-accounts": "Accounts you can't inspect",
  })[value.kind];

export interface MemberDirectoryEntry {
  readonly person: string;
  readonly displayName: string;
  /** Made at least one request in the selected range. */
  readonly active: boolean;
}

/** Local label only for the caller hash returned by the personal read. */
export const personalDirectory = (person: string, active: boolean): MemberDirectoryEntry[] => [
  { person, displayName: "You", active },
];

export interface Row {
  readonly id: string;
  readonly label: string;
  /** Only redacted rows: counted, never split by person, lab or model. */
  readonly countsOnly: boolean;
  readonly provider: string | null;
  readonly totals: Totals;
  /** Tokens per provider, for the stacked bar. */
  readonly byProvider: Map<string, bigint>;
  readonly children: Row[];
  readonly empty: boolean;
  readonly requestTokens: {
    readonly p50: number | null;
    readonly p90: number | null;
    readonly p99: number | null;
  } | null;
  readonly usageKey: {
    readonly person?: string | null;
    readonly provider?: string | null;
    readonly model?: string | null;
  };
}

interface Draft {
  id: string;
  label: string;
  countsOnly: boolean;
  missingModel?: boolean;
  provider: string | null;
  totals: Totals;
  byProvider: Map<string, bigint>;
  children: Map<string, Draft>;
  empty?: boolean;
  requestTokens?: {
    readonly p50: number | null;
    readonly p90: number | null;
    readonly p99: number | null;
  } | null;
  usageKey?: {
    readonly person?: string | null;
    readonly provider?: string | null;
    readonly model?: string | null;
  };
}

const draft = (id: string, label: string, countsOnly: boolean, provider: string | null): Draft => ({
  id,
  label,
  countsOnly,
  provider,
  totals: emptyTotals(),
  byProvider: new Map(),
  children: new Map(),
});

function finish(drafts: Iterable<Draft>): Row[] {
  return [...drafts]
    .map((entry) => ({
      ...entry,
      label: entry.missingModel && noRecordedUsage(entry.totals) ? "Failed requests" : entry.label,
      empty: entry.empty ?? entry.totals.requests === 0,
      requestTokens: entry.requestTokens ?? null,
      usageKey: entry.usageKey ?? {},
      children: finish(entry.children.values()),
    }))
    .sort(
      (a, b) =>
        Number(a.countsOnly) - Number(b.countsOnly) ||
        (b.totals.tokens > a.totals.tokens ? 1 : b.totals.tokens < a.totals.tokens ? -1 : 0) ||
        b.totals.requests - a.totals.requests ||
        a.label.localeCompare(b.label),
    );
}

export type Grouping = "person" | "provider" | "model";

/** Rows open from people to models, labs to people, and model+lab pairs to people. */
export function rows(
  groups: readonly SeriesGroup[],
  by: Grouping,
  providerName: (id: string) => string,
  directory: readonly MemberDirectoryEntry[] = [],
  requestTokens?: {
    readonly byPerson: readonly {
      readonly person: string;
      readonly p50: number | null;
      readonly p90: number | null;
      readonly p99: number | null;
    }[];
    readonly byModel: readonly {
      readonly provider: string;
      readonly model: string;
      readonly p50: number | null;
      readonly p90: number | null;
      readonly p99: number | null;
    }[];
    readonly byModelPerson: readonly {
      readonly person: string;
      readonly provider: string;
      readonly model: string;
      readonly p50: number | null;
      readonly p90: number | null;
      readonly p99: number | null;
    }[];
  },
): Row[] {
  const people = new Map(directory.map((entry) => [entry.person, entry]));
  const byPerson = new Map(requestTokens?.byPerson.map((value) => [value.person, value]) ?? []);
  const byModel = new Map(
    requestTokens?.byModel.map((value) => [JSON.stringify([value.provider, value.model]), value]) ??
      [],
  );
  const byModelPerson = new Map(
    requestTokens?.byModelPerson.map((value) => [
      JSON.stringify([value.provider, value.model, value.person]),
      value,
    ]) ?? [],
  );
  const top = new Map<string, Draft>();
  for (const group of groups) {
    const owner = who(group.key);
    const redacted = owner.kind === "unmapped" || owner.kind === "other-accounts";
    const provider = redacted ? null : (group.key.provider ?? null);
    const providerKey = provider ?? "unknown-provider";
    const providerLabel = provider ? providerName(provider) : "Provider not recorded";
    let id: string, label: string;
    if (redacted) [id, label] = [whoId(owner), whoLabel(owner)];
    else if (by === "person") {
      const member = owner.kind === "person" ? people.get(owner.id) : undefined;
      [id, label] = [whoId(owner), member?.displayName || whoLabel(owner)];
    } else if (by === "provider") [id, label] = [providerKey, providerLabel];
    else
      [id, label] = [
        `${providerKey}:${group.key.model ?? ""}`,
        group.key.model ?? "Model not recorded",
      ];
    const row = top.get(id) ?? draft(id, label, redacted, by === "person" ? null : provider);
    top.set(id, row);
    row.missingModel = !redacted && by === "model" && group.key.model == null;
    row.usageKey =
      by === "person" && owner.kind === "person"
        ? { person: owner.id }
        : by === "provider"
          ? { provider }
          : by === "model"
            ? { provider, model: group.key.model ?? null }
            : {};
    if (by === "person" && owner.kind === "person") {
      row.requestTokens = byPerson.get(owner.id) ?? null;
      const member = people.get(owner.id);
      if (member) row.empty = !member.active;
    }
    if (by === "model" && provider)
      row.requestTokens = byModel.get(JSON.stringify([provider, group.key.model ?? ""])) ?? null;
    const child = redacted
      ? null
      : by === "person"
        ? [
            JSON.stringify([providerKey, group.key.model ?? null]),
            group.key.model ?? "Model not recorded",
            provider,
          ]
        : owner.kind === "person"
          ? [whoId(owner), people.get(owner.id)?.displayName || whoLabel(owner), provider]
          : null;
    const sub = child
      ? (row.children.get(child[0]!) ?? draft(child[0]!, child[1]!, false, child[2] ?? null))
      : null;
    if (sub) {
      sub.missingModel = by === "person" && group.key.model == null;
      if (by === "person" && owner.kind === "person")
        sub.usageKey = { person: owner.id, provider, model: group.key.model ?? null };
      else if (by === "provider" && owner.kind === "person")
        sub.usageKey = { person: owner.id, provider };
      else if (by === "model" && owner.kind === "person")
        sub.usageKey = { person: owner.id, provider, model: group.key.model ?? null };
      if ((by === "model" || by === "person") && owner.kind === "person")
        sub.requestTokens =
          byModelPerson.get(JSON.stringify([provider, group.key.model ?? "", owner.id])) ?? null;
      row.children.set(sub.id, sub);
    }
    for (const bucket of group.buckets) {
      const before = row.totals.tokens;
      addBucket(row.totals, bucket);
      if (sub) addBucket(sub.totals, bucket);
      const added = row.totals.tokens - before;
      if (added > 0n && provider) {
        row.byProvider.set(provider, (row.byProvider.get(provider) ?? 0n) + added);
        sub?.byProvider.set(provider, (sub.byProvider.get(provider) ?? 0n) + added);
      }
    }
  }
  if (by === "person")
    for (const member of directory) {
      const id = `person:${member.person}`;
      if (top.has(id)) continue;
      const row = draft(id, member.displayName || "Member", false, null);
      row.empty = true;
      row.usageKey = { person: member.person };
      row.requestTokens = byPerson.get(member.person) ?? null;
      top.set(id, row);
    }
  for (const row of top.values())
    if (row.empty === undefined) row.empty = row.totals.requests === 0;
  return finish(top.values());
}

export function total(groups: readonly SeriesGroup[]): Totals {
  const sum = emptyTotals();
  for (const group of groups) for (const bucket of group.buckets) addBucket(sum, bucket);
  return sum;
}

// ---------- formatting ----------

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** "12.4M"; exact digits go in a title. */
export const tokensShort = (value: bigint) => compact.format(Number(value));
export const tokensExact = (value: bigint) => value.toLocaleString("en");

/** "$84.20" for USD; "1,204.5 credits" for any other unit Home charges in. */
export function money(value: Money): string {
  const amount = decimalNumber(value.amount);
  if (value.currency === "USD") {
    if (amount > 0 && amount < 0.01) return "<$0.01";
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  const text = new Intl.NumberFormat("en", {
    maximumFractionDigits: amount > 0 && amount < 1 ? 4 : 2,
  }).format(amount);
  return `${text} ${value.currency.toLowerCase() === "credits" ? "credits" : value.currency}`;
}

export const moneyList = (list: readonly Money[]) => list.map(money).join(" + ");
export const moneyExact = (list: readonly Money[]) =>
  list.map((entry) => `${decimalText(entry.amount)} ${entry.currency}`).join(" + ");

/** Why parts of the series may be incomplete, in the order they matter. */
export function coverageNotes(read: SeriesRead): string[] {
  const notes: string[] = [];
  const { coverage } = read;
  if (read.truncated)
    notes.push(
      `Showing the first ${maxSeriesPages} pages of usage. The rest of this range isn't included, so totals are partial.`,
    );
  if (read.asOfChanged)
    notes.push(
      "New usage landed while this was read, so some pages are newer than others. Reload for one consistent view.",
    );
  if (
    coverage.mapping.proof !== "proven" &&
    coverage.mapping.unmapped + coverage.mapping.otherAccounts > 0
  )
    notes.push(
      "Account mapping is pending, so some requests are counted but not split by person, lab or model.",
    );
  const arriving = coverage.sources.filter(
    (source) => source.kind === "import" && source.backfillComplete !== true,
  );
  if (arriving.length)
    notes.push(
      `Imported history from ${arriving.length} ${arriving.length === 1 ? "source is" : "sources are"} still arriving, so earlier days can still change.`,
    );
  return notes;
}
