export function overviewFixture(input, usage) {
  const unavailable = { status: "unavailable", reason: "Synthetic fixture has no price source." };
  const coverage = {
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
      unpriced: 0,
      missing: 0,
      missingSnapshot: 0,
      missingVersion: 0,
      apiEquivalent: unavailable,
    },
    priceProjection: unavailable,
    percentiles: unavailable,
    seasonalTrainingRange: unavailable,
  };
  const tokens = Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].map((key) => [
      key,
      { sum: String(usage.total.tokens[key] ?? 0), known: usage.total.requests, missing: 0 },
    ]),
  );
  const money = { amount: null, currency: null, priced: 0, unpriced: usage.total.requests };
  const bucket = {
    at: input.from,
    partial: false,
    requests: usage.total.requests,
    failed: 0,
    unassignedFailures: 0,
    successRate: 1,
    lastSuccessAtInRange: null,
    tokens,
    tokenQuality: { complete: usage.total.requests, legacy: 0, unclassified: 0, inconsistent: 0 },
    cost: {
      homeCharge: money,
      importedApiPrice: money,
      apiEquivalent: unavailable,
      unpricedRequests: usage.total.requests,
    },
    attribution: {
      chargeSnapshot: 0,
      keyAtCapture: 0,
      importOwner: 0,
      unknown: usage.total.requests,
    },
  };
  const series = {
    from: input.from,
    to: input.to,
    bucket: "day",
    asOf: null,
    coverage,
    groups: usage.models.map((model) => ({
      key: { currency: null, provider: model.provider, model: model.model },
      buckets: [bucket],
    })),
    next: null,
  };
  const metric = {
    ...unavailable,
    amount: null,
    currency: "USD",
    pricedRequests: 0,
    excluded: { unknownKind: 0, unknownKindValue: null, unpriced: usage.total.requests },
    price: null,
  };
  return {
    from: input.from,
    to: input.to,
    asOf: null,
    consistency: "consistent",
    homeCapture: { capturedAt: null, completeHours: [] },
    directory: { members: [], activeCount: 0, totalCount: 0 },
    people: series,
    models: series,
    requestsByHour: [],
    metrics: {
      requestTokens: {
        ...unavailable,
        percentiles: null,
        requests: 0,
        excluded: { missing: 0, unknownKind: 0 },
        byPerson: [],
        byModel: [],
        byModelPerson: [],
      },
      apiBilled: metric,
      subscriptionValue: metric,
      perActivePersonPerDay: {
        ...unavailable,
        p50: null,
        p90: null,
        currency: "USD",
        activePeople: 0,
        completeDays: 0,
      },
      failureShareWorstHourP95: { ...unavailable, p95: null, unit: "percent", hours: 0 },
      usageSlices: [],
    },
    partial: false,
  };
}

export function capacityFixture(input) {
  const to = input.to;
  const from = Math.floor((to - input.days * 86_400_000) / 3_600_000) * 3_600_000;
  return {
    ok: true,
    value: {
      from,
      to,
      readAt: null,
      trackingSince: null,
      completedWeeks: 0,
      points: [],
      forecasts: [],
      refillEvents: [],
      estimate: { status: "learning", reason: "Synthetic fixture has no capacity history." },
    },
  };
}
