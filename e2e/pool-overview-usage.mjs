// Synthetic usage data for the pool overview journey, shaped like the model-history worker's
// signed answers. Only the external pool boundary is synthetic; the host bridge, the real pool app
// and its kit read it exactly as they would the worker.

const day = 86_400_000;
const zurichDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const money = (value) => value.toFixed(6).replace(/\.?0+$/u, "");
const token = (value) => ({ sum: value === null ? null : String(value), known: 1, missing: 0 });
const price = { asOf: "2026-11-01T00:00:00Z", source: "synthetic", version: "1", basis: "live" };

export const labs = {
  // Requests a day, dollars per request; each lab's last day is today, partial.
  codex: { requests: 40, perRequest: 0.05, unpriced: 0 },
  claude: { requests: 20, perRequest: 0.08, unpriced: 1 },
};

function days(from, to) {
  const out = [];
  for (let at = Date.parse(from); at < Date.parse(to); at += day) {
    const end = Math.min(at + day, Date.parse(to));
    out.push({ at, end, partial: end === Date.parse(to) && end - at < day });
  }
  return out;
}

function bucket({ at, end, partial }, lab, scale, index) {
  const shape = labs[lab];
  const requests = Math.round((shape.requests + (index % 3) * 5) * scale);
  const priced = Math.max(0, requests - shape.unpriced);
  return {
    at: new Date(at).toISOString(),
    end: new Date(end).toISOString(),
    partial,
    requests,
    failed: 1,
    limited: 0,
    details: {
      tokens: {
        input: token(requests * 600),
        output: token(requests * 100),
        cacheRead: token(requests * 300),
        cacheWrite: token(0),
        reasoning: token(0),
        total: token(requests * 1000),
      },
      apiEstimate: {
        status: "available",
        amount: money(priced * shape.perRequest),
        currency: "USD",
        pricedRequests: priced,
        excluded: { unknownKind: 0, unknownKindValue: null, unpriced: requests - priced },
        price,
      },
    },
  };
}

const groups = (from, to, scale, model) =>
  Object.keys(labs).flatMap((lab) => {
    const list = days(from, to).map((entry, index) => bucket(entry, lab, scale, index));
    if (!model) return [{ provider: lab, countsOnly: false, buckets: list }];
    const half = (b) => ({
      ...b,
      requests: Math.floor(b.requests / 2),
      details: {
        ...b.details,
        tokens: { ...b.details.tokens, total: token((Math.floor(b.requests / 2) || 0) * 1000) },
        apiEstimate: {
          ...b.details.apiEstimate,
          amount: money(Math.floor(b.requests / 2) * labs[lab].perRequest),
          pricedRequests: Math.floor(b.requests / 2),
          excluded: { unknownKind: 0, unknownKindValue: null, unpriced: 0 },
        },
      },
    });
    return [
      { provider: lab, model: `${lab}-large`, countsOnly: false, buckets: list.map(half) },
      // A model the ledger never recorded stays unknown rather than borrowing a name.
      {
        provider: lab,
        model: lab === "claude" ? null : `${lab}-mini`,
        countsOnly: false,
        buckets: list.map(half),
      },
    ];
  });

const projection = (from, through, actual, median, low, high) => ({
  from,
  through,
  actual,
  median,
  low,
  high,
});

function forecast(now, available, scale) {
  const today = zurichDay.format(new Date(now));
  if (!available)
    return {
      status: "unavailable",
      reason: "insufficient-history",
      comparableWeeks: 2,
      calculatedAt: new Date(now).toISOString(),
    };
  return {
    status: "available",
    calculatedAt: new Date(now).toISOString(),
    timezone: "Europe/Zurich",
    method: "Median of the last 4 full weeks, shaped by day of week",
    confidence: "Medium",
    coverage: { basis: "recorded-total", excludedRequests: 0 },
    interval: 0.8,
    comparableWeeks: 4,
    trainingWeeks: ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"],
    misses: [
      {
        week: "2026-10-19",
        predicted: 300 * scale,
        actual: 330 * scale,
        error: 30 * scale,
        share: 0.1,
      },
      {
        week: "2026-10-26",
        predicted: 320 * scale,
        actual: 300 * scale,
        error: -20 * scale,
        share: -0.06,
      },
      {
        week: "2026-11-02",
        predicted: 310 * scale,
        actual: 340 * scale,
        error: 30 * scale,
        share: 0.09,
      },
    ],
    thisWeek: projection(today, today, 180 * scale, 320 * scale, 290 * scale, 360 * scale),
    nextWeek: projection(today, today, null, 330 * scale, null, null),
    month: projection("2026-11-01", today, 600 * scale, 1400 * scale, 1250 * scale, 1600 * scale),
    daily: Array.from({ length: 7 }, (_, offset) => ({
      day: zurichDay.format(new Date(now + (offset + 1) * day)),
      median: 50 * scale,
      low: 40 * scale,
      high: 62 * scale,
    })),
  };
}

const series = (provider, now, available) => ({
  provider,
  requests: forecast(now, available, 1),
  tokens: forecast(now, available, 1000),
  apiEstimate: forecast(now, available, 0.06),
  excluded: { tokens: 0, apiEstimate: 0 },
});

const coverage = (from, to) => ({
  sources: [
    {
      source: "home",
      kind: "home",
      firstAt: new Date(Date.parse(from) - 60 * day).toISOString(),
      lastAt: to,
      backfillComplete: true,
      sweep: null,
    },
    {
      source: "import-synthetic",
      kind: "import",
      firstAt: new Date(Date.parse(from) - 120 * day).toISOString(),
      lastAt: new Date(Date.parse(from) - 60 * day).toISOString(),
      backfillComplete: true,
      sweep: null,
    },
  ],
  firstAt: new Date(Date.parse(from) - 120 * day).toISOString(),
  lastAt: to,
  capturedThrough: to,
  mapping: {
    current: true,
    historicalGenerations: "unknown",
    proof: "proven",
    mapped: 1,
    unmapped: 0,
    otherAccounts: 0,
  },
  pricing: {
    homeCharge: 0,
    importedApiPrice: 0,
    unpriced: 0,
    missing: 0,
    missingSnapshot: 0,
    missingVersion: 0,
    apiEquivalent: { status: "unavailable", reason: "synthetic" },
  },
  priceProjection: { status: "unavailable", reason: "synthetic" },
  percentiles: { status: "unavailable", reason: "synthetic" },
  seasonalTrainingRange: { status: "unavailable", reason: "synthetic" },
});

/** The worker's summary for one signed read, by its own clipped bounds and previous range. */
export function summaryReply(input, now = Date.now()) {
  const { from, to } = input;
  const span = Date.parse(to) - Date.parse(from);
  const previous = {
    from: new Date(Date.parse(from) - span).toISOString(),
    to: from,
  };
  const known = days(from, to).map((entry) => zurichDay.format(new Date(entry.at)));
  const cells = [];
  for (let weekday = 0; weekday < 5; weekday++)
    for (let hour = 9; hour < 18; hour++)
      for (const provider of Object.keys(labs))
        cells.push({
          provider,
          weekday,
          hour,
          requests: 8,
          // One hour's tokens went unrecorded; it stays unknown, never a zero.
          tokens: token(weekday === 2 && hour === 12 ? null : (hour - 8) * 4000),
          sampleHours: 8,
        });
  return {
    from,
    to,
    timezone: "Europe/Zurich",
    previous,
    readFrom: new Date(Date.parse(from) - 56 * day).toISOString(),
    asOf: to,
    coverage: coverage(from, to),
    historyCoverage: { from, to, knownDays: known.slice(1), gapDays: known.slice(0, 1) },
    daily: groups(from, to, 1, false),
    previousDaily: groups(previous.from, previous.to, 0.8, false),
    models:
      input.by === "model" ? { status: "available", groups: groups(from, to, 1, true) } : null,
    forecasts: {
      calculatedAt: new Date(now).toISOString(),
      timezone: "Europe/Zurich",
      basis: "recorded-usage",
      warnings: [],
      series: [series(null, now, true), series("codex", now, true), series("claude", now, false)],
    },
    usageSlices: Object.keys(labs).map((provider) => ({
      person: null,
      provider,
      model: null,
      requests: 100,
      apiBilled: provider === "codex" ? "5.000000" : "7.920000",
      apiPricedRequests: provider === "codex" ? 100 : 99,
      apiUnpriced: provider === "codex" ? 0 : 1,
      subscriptionValue: null,
      subscriptionPricedRequests: 0,
      subscriptionUnpriced: 0,
      unknownKind: 0,
      unknownKindValue: null,
      price,
    })),
    heatmap: {
      from: new Date(Date.parse(to) - 56 * day).toISOString(),
      to,
      basis: "recorded-usage",
      status: "available",
      cells,
    },
    // A hung-up client is never the pool failing: the 499 must not count toward the alert.
    incidents: {
      from: new Date(now - 3_600_000).toISOString(),
      to: new Date(now).toISOString(),
      status: "available",
      requests: 40,
      failed: 4,
      failures: [
        { status: 502, count: 2 },
        { status: 429, count: 1 },
        { status: 499, count: 1 },
      ],
    },
    homeCapture: { status: "available", capturedAt: to, completeHours: [] },
    requestsByHour: [],
    partial: false,
  };
}

const sum = (value) => ({ sum: value === null ? null : String(value), known: 1, missing: 0 });
const cost = { amount: null, currency: null, priced: 0, unpriced: 0 };

function seriesBucket({ at, end, partial }, requests, perRequest) {
  return {
    at: new Date(at).toISOString(),
    end: new Date(end).toISOString(),
    partial,
    requests,
    failed: 0,
    unassignedFailures: 0,
    successRate: 1,
    lastSuccessAtInRange: null,
    tokens: {
      input: sum(requests * 600),
      output: sum(requests * 100),
      cacheRead: sum(requests * 300),
      cacheWrite: sum(0),
      reasoning: sum(0),
      total: sum(requests * 1000),
    },
    tokenQuality: { complete: requests, legacy: 0, unclassified: 0, inconsistent: 0 },
    cost: {
      homeCharge: cost,
      importedApiPrice: cost,
      apiEquivalent: { status: "unavailable", reason: "synthetic" },
      apiEstimate: {
        status: "available",
        amount: money(requests * perRequest),
        currency: "USD",
        pricedRequests: requests,
        excluded: { unknownKind: 0, unknownKindValue: null, unpriced: 0 },
        price,
      },
      unpricedRequests: 0,
    },
    attribution: { chargeSnapshot: 0, keyAtCapture: requests, importOwner: 0, unknown: 0 },
  };
}

export const importedAccount = `imported:${"a".repeat(64)}`;
export const importedLabel = "Old laptop export";

/**
 * Accounts by lab across two pages. The imported account continues on page two without its
 * display, so the page has to keep the label it got on page one.
 */
export function seriesReply(payload, inPool) {
  const { from, to, after } = payload.input;
  const list = days(from, to);
  const base = {
    from,
    to,
    bucket: "day",
    timezone: "Europe/Zurich",
    asOf: to,
    coverage: coverage(from, to),
  };
  if (after === undefined)
    return {
      ...base,
      groups: [
        {
          key: { currency: "USD", provider: "codex", account: inPool },
          buckets: list.map((entry) => seriesBucket(entry, 30, 0.05)),
        },
        {
          key: { currency: "USD", provider: "claude", account: importedAccount },
          accountDisplay: { kind: "imported-only", label: importedLabel },
          buckets: list.slice(0, 2).map((entry) => seriesBucket(entry, 12, 0.08)),
        },
      ],
      next: "page-2",
    };
  return {
    ...base,
    groups: [
      {
        key: { currency: "USD", provider: "claude", account: importedAccount },
        buckets: list.slice(2).map((entry) => seriesBucket(entry, 12, 0.08)),
      },
      {
        key: { currency: "USD", provider: "claude", account: null },
        accountDisplay: { kind: "no-account-recorded", label: null },
        buckets: list.map((entry) => seriesBucket(entry, 5, 0.08)),
      },
    ],
    next: null,
  };
}

/**
 * The worker's capacity history for one lab: a week of hourly readings of a single Plus account
 * drawing its weekly allowance down, with no forecast yet. The pool app's own capacity view
 * decides the verdict from it.
 */
export function capacityReply(url) {
  const hour = 3_600_000;
  const days = Number(url.searchParams.get("days") ?? 7);
  const to = Number(url.searchParams.get("to") ?? Date.now());
  const last = Math.floor(to / hour) * hour;
  const from = last - days * day;
  const aggregate = (remaining, at) => ({
    remaining,
    full: 1,
    at,
    observedAt: { from: at, to: at },
    accountCount: 1,
    knownWeightCount: 1,
    unknownWeightCount: 0,
    weights: [{ source: "reference-plan", revision: "synthetic", accountCount: 1 }],
  });
  const points = [];
  for (let at = from; at <= last; at += hour) {
    const value = aggregate(Math.max(0.2, 1 - ((at - from) / (last - from || 1)) * 0.6), at);
    points.push({
      provider: "codex",
      windowSeconds: 604800,
      mode: null,
      unit: { id: "plus-eq", label: "Plus-eq" },
      hour: at,
      minimum: value,
      last: value,
      plans: [{ plan: "Plus", minimum: value, last: value }],
    });
  }
  return {
    from,
    to,
    readAt: to,
    trackingSince: from - 28 * day,
    completedWeeks: 4,
    points,
    forecasts: [],
    refillEvents: [],
    estimate: { status: "learning", reason: "Synthetic history has no forecast yet." },
  };
}
