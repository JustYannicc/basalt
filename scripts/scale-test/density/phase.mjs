import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { operation } from "./clients.mjs";
const percentile = (xs, p) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1] : null;
export function readResourceSamples(file) {
  const raw = readFileSync(file, "utf8");
  return raw
    .slice(0, raw.lastIndexOf("\n"))
    .split("\n")
    .filter(Boolean)
    .map((x) => JSON.parse(x));
}
export async function measurePhase(
  context,
  profile,
  workload,
  concurrency,
  durationMs,
  kind,
  baseline,
) {
  const { out, ports, home, json, attempt, executionStart: began, phaseNumber } = context;
  const save = (file, data) =>
    writeFileSync(join(out, file), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  if (Date.now() - began > 3 * 3600000) throw Error("Three-hour density execution ceiling reached");
  const name = [profile.name, workload.name, kind, concurrency, phaseNumber].join("-");
  const settings = {
    rate: workload.rate,
    contentBytes: workload.contentBytes,
    durationMs: 60000,
    phase: name,
  };
  await json(ports.mock + "/settings", { method: "POST", body: JSON.stringify(settings) });
  const before = await home("/capabilities"),
    start = Date.now(),
    deadline = start + durationMs,
    records = [],
    telemetry = [],
    hostLoadStart = loadavg();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const generatorCpu = process.cpuUsage();
  let samplerRunning = true;
  const sampling = (async () => {
    while (samplerRunning) {
      const at = Date.now();
      try {
        telemetry.push({
          at,
          mock: await json(ports.mock + "/stats"),
          database: (await home("/capabilities")).server_info.database_pool,
          generator: {
            cpu: process.cpuUsage(generatorCpu),
            rss: process.memoryUsage().rss,
            lagP99Ms: loop.percentile(99) / 1e6,
            lagMaxMs: loop.max / 1e6,
          },
        });
      } catch (error) {
        telemetry.push({ at, error: error.message });
      }
      await delay(Math.max(1, 1000 - (Date.now() - at)));
    }
  })();
  let stop = false;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      let turn = 0;
      const protocol = ["messages", "responses", "websocket"][i % 3];
      while (Date.now() < deadline && !stop) {
        const id = "density-op-" + attempt + "-" + phaseNumber + "-" + i + "-" + turn++;
        const record = await operation(
          ports.node,
          protocol,
          id,
          60000,
          workload.contentBytes,
          workload.rate,
        );
        records.push(record);
        appendFileSync(
          join(out, "operations.ndjson"),
          JSON.stringify({ phase: name, ...record }) + "\n",
        );
        if (!record.pass) stop = true;
      }
    }),
  );
  samplerRunning = false;
  await sampling;
  loop.disable();
  await json(ports.mock + "/flush");
  const end = Date.now(),
    after = await home("/capabilities");
  const allSamples = readResourceSamples(join(out, profile.name + "-resources.ndjson"));
  const resource = allSamples.filter((x) => x.at >= start + 5000 && x.at < deadline && x.cpu);
  const cpu = [];
  for (let i = 1; i < resource.length; i++) {
    const a = resource[i - 1],
      b = resource[i];
    cpu.push((b.cpu.usage_usec - a.cpu.usage_usec) / 1e6 / (b.monotonic - a.monotonic));
  }
  const dbBefore = before.server_info.database_pool,
    dbAfter = after.server_info.database_pool;
  const waitCount = dbAfter.wait_count - dbBefore.wait_count,
    waitNs = dbAfter.wait_duration_ns - dbBefore.wait_duration_ns;
  const steady = telemetry.filter((x) => x.at >= start + 5000 && x.at < deadline),
    valid = steady.filter((x) => !x.error);
  const ownFailures = records.filter((x) => !x.pass),
    cpuP95 = percentile(cpu, 0.95),
    memoryMax = Math.max(0, ...resource.map((x) => x.memoryCurrent));
  const ttfb95 = percentile(
      records.map((x) => x.firstByteMs).filter((x) => x !== null),
      0.95,
    ),
    ttfb99 = percentile(
      records.map((x) => x.firstByteMs).filter((x) => x !== null),
      0.99,
    );
  const runtimePids = Object.fromEntries(
    ["cliproxy-home", "cliproxy-node"].map((comm) => [
      comm,
      [
        ...new Set(
          resource.flatMap((sample) =>
            sample.processes
              .filter((process) => process.comm === comm)
              .map((process) => process.pid),
          ),
        ),
      ],
    ]),
  );
  const steadyOverlapFraction =
    valid.filter((sample) => sample.mock.active >= concurrency * 0.95).length / valid.length;
  const criteria = {
    allTerminals: records.length >= concurrency && ownFailures.length === 0,
    resourceSamples: resource.length >= (kind === "confirm" ? 300 : 60),
    cpuP95: cpuP95 !== null && cpuP95 <= profile.vcpu * 0.8,
    memory: memoryMax <= profile.memoryGiB * 2 ** 30 * 0.7,
    noTelemetryFailures: telemetry.every((x) => !x.error) && resource.every((x) => !x.error),
    generatorLag: Math.max(0, ...valid.map((x) => x.generator.lagP99Ms)) <= 50,
    mockLag: Math.max(0, ...valid.map((x) => x.mock.lagP99Ms)) <= 50,
    mockActive: Math.max(0, ...valid.map((x) => x.mock.active)) === concurrency,
    steadyOverlap: steadyOverlapFraction >= 0.9,
    noRuntimeRestart: Object.values(runtimePids).every((pids) => pids.length === 1),
    databaseCountersMonotonic: waitCount >= 0 && waitNs >= 0,
    evidenceWriter: valid.every(
      (sample) =>
        sample.mock.evidenceError === null && sample.mock.evidencePendingBytes <= 8 * 2 ** 20,
    ),
    dbMeanWait: waitCount === 0 || waitNs / waitCount / 1e6 <= 10,
    latency:
      !baseline || (ttfb95 - baseline.ttfbP95Ms <= 100 && ttfb99 - baseline.ttfbP99Ms <= 250),
  };
  const result = {
    name,
    profile: profile.name,
    workload: workload.name,
    kind,
    concurrency,
    start,
    deadline,
    end,
    hostLoadStart,
    runtimePids,
    steadyOverlapFraction,
    hostLoadEnd: loadavg(),
    requests: records.length,
    ownFailures,
    criteria,
    pass: Object.values(criteria).every(Boolean),
    cpuP95Cores: cpuP95,
    cpuMeanCores: cpu.reduce((a, b) => a + b, 0) / cpu.length,
    cpuP95Quota: cpuP95 / profile.vcpu,
    throttledUsecDelta: resource.length
      ? resource.at(-1).cpu.throttled_usec - resource[0].cpu.throttled_usec
      : null,
    memoryMaxBytes: memoryMax,
    rssMaxBytes: Math.max(
      0,
      ...resource.map((x) => x.processes.reduce((a, b) => a + b.rssBytes, 0)),
    ),
    fdMax: Math.max(0, ...resource.map((x) => x.processes.reduce((a, b) => a + b.fds, 0))),
    resourceSamples: resource.length,
    ttfbP95Ms: ttfb95,
    ttfbP99Ms: ttfb99,
    upstreamPeak: Math.max(0, ...valid.map((x) => x.mock.active)),
    database: {
      before: dbBefore,
      after: dbAfter,
      waitCountDelta: waitCount,
      waitDurationNsDelta: waitNs,
      meanWaitAmongWaitedCheckoutsMs: waitCount ? waitNs / waitCount / 1e6 : null,
      allCheckoutMean: null,
      p95: null,
      maxInUse: Math.max(0, ...valid.map((x) => x.database.in_use)),
      maxOpen: Math.max(0, ...valid.map((x) => x.database.open_connections)),
    },
    telemetry,
  };
  save(name + ".json", result);
  console.log(
    JSON.stringify({
      phase: name,
      pass: result.pass,
      criteria,
      cpuP95,
      requests: records.length,
      ttfb95,
    }),
  );
  return result;
}
