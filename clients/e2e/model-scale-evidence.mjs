import assert from "node:assert/strict";

export const percentile = (values, fraction) => {
  assert.ok(values.length);
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};
const distribution = (values) => ({
  count: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: Math.max(...values),
});
export function timingEvidence(pairs) {
  const difference = pairs.map(([baseline, load]) => load - baseline);
  let seed = 0x65bd4fe;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const means = [],
    p95s = [],
    p99s = [];
  for (let trial = 0; trial < 4000; trial++) {
    const sample = Array.from(
      { length: pairs.length },
      () => pairs[Math.floor(random() * pairs.length)],
    );
    const before = sample.map((pair) => pair[0]),
      after = sample.map((pair) => pair[1]);
    means.push(sample.reduce((sum, pair) => sum + pair[1] - pair[0], 0) / sample.length);
    p95s.push(percentile(after, 0.95) - percentile(before, 0.95));
    p99s.push(percentile(after, 0.99) - percentile(before, 0.99));
  }
  const addedP95Ms =
    percentile(
      pairs.map((pair) => pair[1]),
      0.95,
    ) -
    percentile(
      pairs.map((pair) => pair[0]),
      0.95,
    );
  const addedP99Ms =
    percentile(
      pairs.map((pair) => pair[1]),
      0.99,
    ) -
    percentile(
      pairs.map((pair) => pair[0]),
      0.99,
    );
  const interval = (values) => [percentile(values, 0.025), percentile(values, 0.975)];
  return {
    pairs: pairs.length,
    addedP95Ms,
    addedP99Ms,
    pairedDifferenceMs: distribution(difference),
    meanDifference95: interval(means),
    addedP95Ms95: interval(p95s),
    addedP99Ms95: interval(p99s),
    pass: pairs.length >= 40 && addedP95Ms <= 100 && addedP99Ms <= 250,
  };
}
export function resourceEvidence(series, phase) {
  assert.ok(phase.count > 0, "The phase histogram must contain real event-loop samples.");
  assert.ok(series.length);
  return {
    samples: series.length,
    cpuRatio: distribution(series.map((sample) => sample.cpuRatio)),
    rssBytes: distribution(series.map((sample) => sample.rss)),
    fdCount: distribution(series.map((sample) => sample.fds)),
    socketCount: distribution(series.map((sample) => sample.sockets)),
    readableBytes: distribution(series.map((sample) => sample.readableBytes)),
    writableBytes: distribution(series.map((sample) => sample.writableBytes)),
    httpBufferedBytes: distribution(series.map((sample) => sample.httpBufferedBytes ?? 0)),
    loopP99Ms: phase.loopP99Ms,
    lifetimeLoopP99Ms: series.at(-1).cumulativeLoopP99Ms,
    phase,
    memoryHeadroomMinimum: Math.min(
      ...series.map((sample) => 1 - sample.rss / sample.memoryLimitBytes),
    ),
    fdHeadroomMinimum: Math.min(
      ...series.filter((sample) => sample.fdLimit).map((sample) => 1 - sample.fds / sample.fdLimit),
    ),
    pass:
      percentile(
        series.map((sample) => sample.cpuRatio),
        0.95,
      ) <= 0.8 &&
      phase.loopP99Ms <= 20 &&
      series.every((sample) => sample.rss <= sample.memoryLimitBytes * 0.7),
  };
}

export function levelEvidence({
  series,
  allOperations,
  count,
  blockStart,
  reachedAt,
  end,
  until,
  complete,
  timings,
  upstreamPeak,
  idleRss,
  idleFds,
  phase,
}) {
  const measured = series.filter(
    (record) => record.phaseId === phase.id && record.at >= blockStart && record.at <= end,
  );
  const resource = resourceEvidence(measured, phase);
  const blockOperations = allOperations.filter(
    (record) => record.gateway === "load" && record.requestedAt >= blockStart,
  );
  const first = blockOperations
    .slice()
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .slice(0, 32);
  const headerMinimumMs = Math.min(
    ...first.map((record) => record.headersAt - record.upstream.receivedAt),
  );
  if (complete) {
    assert.ok(
      headerMinimumMs > 30_000,
      "First32 must withhold headers beyond the old30s queue deadline.",
    );
    if (count === 200)
      assert.ok(
        first.every(
          (record) =>
            record.firstByteAt - record.upstream.receivedAt > 600_000 &&
            record.terminalAt - record.upstream.receivedAt > 600_000,
        ),
        "Thinking and protocol completion must outlive ten minutes of native session age.",
      );
    assert.equal(resource.pass, true, "Native gateway breached CPU/memory/event-loop headroom.");
  }
  const tail = measured.slice(-10),
    headSamples = measured.slice(10, 20);
  const retainedRssGrowthBytes = headSamples.length
    ? percentile(
        tail.map((record) => record.rss),
        0.5,
      ) -
      percentile(
        headSamples.map((record) => record.rss),
        0.5,
      )
    : 0;
  return {
    count,
    reachedAt,
    end,
    plateauMinimumMs: until - reachedAt,
    upstreamPeak: upstreamPeak,
    operations: blockOperations.length,
    operationsByProtocol: Object.fromEntries(
      ["responses", "messages", "websocket"].map((protocol) => [
        protocol,
        blockOperations.filter((record) => record.protocol === protocol).length,
      ]),
    ),
    headerMinimumMs,
    timings,
    resource,
    retainedRssGrowthBytes,
    rssBytesPerActiveAtPeak: (resource.rssBytes.max - idleRss) / count,
    fdPerActiveAtPeak: (resource.fdCount.max - idleFds) / count,
    cpuMicrosPerCompletedOperation:
      measured.reduce((sum, record) => sum + record.cpuRatio * record.intervalMs * 1000, 0) /
      blockOperations.length,
    ownCapWaitMs: 0,
  };
}
