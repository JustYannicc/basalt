const unavailable = (reason) => ({ status: "unavailable", reason });

const token = (value, requests) => ({
  sum: value === null || value === undefined ? null : String(value),
  known: value === null || value === undefined ? 0 : requests,
  missing: value === null || value === undefined ? requests : 0,
});

function tokens(values, requests) {
  return Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].map((key) => [
      key,
      token(values?.[key], requests),
    ]),
  );
}

function estimate(amount, requests, unpriced) {
  if (amount === null || amount === undefined)
    return {
      ...unavailable("No estimate in this fixture."),
      amount: null,
      currency: "USD",
      pricedRequests: 0,
      excluded: { unknownKind: 0, unknownKindValue: null, unpriced: requests },
      price: null,
    };
  return {
    status: "available",
    amount: String(amount),
    currency: "USD",
    pricedRequests: Math.max(0, requests - unpriced),
    excluded: { unknownKind: 0, unknownKindValue: null, unpriced },
    price: null,
  };
}

function summaryGroup(provider, model, values, at, to) {
  const requests = values.requests;
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    countsOnly: false,
    buckets: [
      {
        at,
        end: to,
        partial: true,
        requests,
        failed: 0,
        limited: 0,
        details: {
          tokens: tokens(values.tokens, requests),
          apiEstimate: estimate(values.cost, requests, values.unpriced),
        },
      },
    ],
  };
}

function seriesBucket(bucket) {
  const tokens = bucket.details?.tokens;
  const apiEstimate = bucket.details?.apiEstimate;
  return {
    at: bucket.at,
    end: bucket.end,
    partial: bucket.partial,
    requests: bucket.requests,
    failed: bucket.failed,
    limited: bucket.limited,
    unassignedFailures: 0,
    successRate: 1,
    lastSuccessAtInRange: null,
    tokens: tokens ?? tokensForMissing(bucket.requests),
    tokenQuality: {
      complete: tokens?.total.known ?? 0,
      legacy: 0,
      unclassified: 0,
      inconsistent: 0,
    },
    cost: {
      homeCharge: { amount: null, currency: null, priced: 0, unpriced: bucket.requests },
      importedApiPrice: { amount: null, currency: null, priced: 0, unpriced: bucket.requests },
      apiEquivalent: unavailable("Fixture has no retained Home valuation."),
      apiEstimate,
      unpricedRequests: apiEstimate?.excluded.unpriced ?? bucket.requests,
    },
    attribution: { chargeSnapshot: 0, keyAtCapture: 0, importOwner: 0, unknown: bucket.requests },
  };
}

function tokensForMissing(requests) {
  return Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].map((key) => [
      key,
      token(null, requests),
    ]),
  );
}

/** Converts the old readiness fixture's totals without importing unrelated synthetic usage. */
export function summaryFixture(input, usage, partial = false) {
  const { from, to } = input;
  const total = usage.total;
  const requests = total.requests;
  const cost = total.cost ?? null;
  const unpriced = total.unpriced ?? 0;
  const models = usage.models ?? [];
  const providers = [...new Set(models.map((model) => model.provider ?? null))];
  const provider = providers.length === 1 ? providers[0] : null;
  const at = new Date(Date.parse(to) - 1).toISOString();
  const whole = requests > 0;
  const daily = whole
    ? [
        summaryGroup(
          provider,
          undefined,
          { requests, cost, unpriced, tokens: total.tokens },
          at,
          to,
        ),
      ]
    : [];
  const modelGroups = models.map((model) => {
    const count = model.requests ?? (models.length === 1 ? requests : 1);
    return summaryGroup(
      model.provider ?? null,
      model.model ?? null,
      {
        requests: count,
        cost: model.cost ?? (models.length === 1 ? cost : null),
        unpriced: model.unpriced ?? (models.length === 1 ? unpriced : count),
        tokens: model.tokens ?? (models.length === 1 ? total.tokens : undefined),
      },
      at,
      to,
    );
  });
  const days = [];
  const lastDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(to));
  for (let day = new Date(from); day < new Date(to); day.setUTCDate(day.getUTCDate() + 1))
    days.push(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Zurich",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(day),
    );
  const knownDays = whole ? [lastDay] : [];
  const coverageDays = new Set(knownDays);
  return {
    from,
    to,
    timezone: "Europe/Zurich",
    previous: {
      from: new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from))).toISOString(),
      to: from,
    },
    readFrom: from,
    retainedFirstAt: null,
    asOf: null,
    coverage: {
      sources: [],
      firstAt: null,
      lastAt: null,
      capturedThrough: null,
      mapping: {
        current: true,
        historicalGenerations: "unknown",
        proof: "unavailable",
        mapped: 0,
        unmapped: 0,
        otherAccounts: 0,
      },
      pricing: {
        homeCharge: 0,
        importedApiPrice: 0,
        unpriced,
        missing: 0,
        missingSnapshot: 0,
        missingVersion: 0,
        apiEquivalent: unavailable("No retained valuation in this fixture."),
      },
      priceProjection: unavailable("No price projection in this fixture."),
      percentiles: unavailable("No percentiles in this fixture."),
      seasonalTrainingRange: unavailable("No training range in this fixture."),
    },
    historyCoverage: {
      from,
      to,
      knownDays,
      gapDays: days.filter((day) => !coverageDays.has(day)),
    },
    daily,
    previousDaily: [],
    models: input.by === "model" ? { status: "available", groups: modelGroups } : null,
    forecasts: {
      calculatedAt: to,
      timezone: "Europe/Zurich",
      basis: "recorded-usage",
      warnings: [],
      // A test opts in to per-lab forecast rows; each lab's forecast is still learning.
      series: (usage.forecastProviders ?? []).map((lab) => {
        const learning = {
          status: "unavailable",
          reason: "insufficient-history",
          comparableWeeks: 0,
          calculatedAt: to,
        };
        return {
          provider: lab,
          requests: learning,
          tokens: learning,
          apiEstimate: learning,
          excluded: { tokens: 0, apiEstimate: 0 },
        };
      }),
    },
    usageSlices: [
      {
        person: null,
        provider,
        model: null,
        requests,
        apiBilled: cost === null ? null : String(cost),
        apiPricedRequests: Math.max(0, requests - unpriced),
        apiUnpriced: unpriced,
        subscriptionValue: null,
        subscriptionPricedRequests: 0,
        subscriptionUnpriced: 0,
        unknownKind: 0,
        unknownKindValue: null,
        price: null,
      },
    ],
    heatmap: {
      from,
      to,
      basis: "recorded-usage",
      status: "unavailable",
      reason: "No hourly records in this fixture.",
      cells: [],
    },
    incidents: {
      from: new Date(Date.parse(to) - 3_600_000).toISOString(),
      to,
      status: "unavailable",
      requests: 0,
      failed: 0,
      failures: [],
    },
    homeCapture: { status: "unavailable", capturedAt: null, completeHours: [] },
    requestsByHour: [],
    partial,
  };
}

/** Account detail is intentionally unattributed: the old fixture has no account identifiers. */
export function seriesFixture(input, usage, next = null) {
  const summary = summaryFixture({ ...input, by: "provider" }, usage);
  return {
    from: input.from,
    to: input.to,
    bucket: "day",
    timezone: "Europe/Zurich",
    asOf: null,
    coverage: summary.coverage,
    groups: summary.daily.map((group) => ({
      key: { currency: null, provider: group.provider, account: null },
      accountDisplay: { kind: "no-account-recorded", label: null },
      buckets: group.buckets.map(seriesBucket),
    })),
    next,
  };
}
