import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { command } from "./support.ts";
import { now } from "./model-scale-protocol.ts";
import { scaleSession } from "./model-scale-session.mjs";
import { scalePeer } from "./model-scale-peer.ts";
import { timingEvidence, levelEvidence } from "./model-scale-evidence.mjs";

const [directory, expectedHead, mode = "complete"] = process.argv.slice(2);
assert.ok(directory && /^[a-f0-9]{40}$/u.test(expectedHead ?? ""));
assert.ok(["complete", "smoke"].includes(mode));
const head =
  mode === "complete"
    ? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : expectedHead;
assert.equal(head, expectedHead, "The proof must use the exact requested head.");
mkdirSync(directory, { recursive: true });
const output = (file, value) =>
  appendFileSync(join(directory, file), JSON.stringify(value) + "\n", { mode: 0o600 });
const complete = mode === "complete";
const sourceIdentity = {};
function identify(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) identify(file);
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|json)$/u.test(file))
      sourceIdentity[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
}
for (const folder of [
  "clients/cli",
  "clients/connection",
  "clients/contracts",
  "clients/e2e",
  "src/setup",
])
  identify(folder);
if (complete)
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      encoding: "utf8",
    }).trim(),
    "",
    "Freeze a clean candidate before acceptance.",
  );
const workload = {
  regularTextBytesPerSecond: 512,
  streamMilliseconds: 60_000,
  maximumSlowHttpLanes: 8,
  slowInitialBurstFrames: 64,
  slowTextBytesPerBurstFrame: 15_000,
  slowInitialBurstTextBytes: 960_000,
  slowReaderPauseMilliseconds: 5000,
  framing: "SSE or JSON frames add measured wire bytes, retained per operation",
  steadyOwnCapWaitMilliseconds: 0,
};
const fingerprint = {
  head,
  workload,
  sourceIdentity,
  sourceTreeSha256: createHash("sha256").update(JSON.stringify(sourceIdentity)).digest("hex"),
  mode,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  pid: process.pid,
  scope:
    "Public native CLI plus synthetic OAuth/native protocol peer. Backend Worker/DO/Home/node deployment is a separate integration proof.",
  hostedCostUsd: 0,
};
writeFileSync(join(directory, "fingerprint.json"), JSON.stringify(fingerprint, null, 2) + "\n");
const peer = scalePeer();
const session = scaleSession(directory, peer, output);
const { connect, operation, stop, failed, series, clients, allOperations } = session;
const start = now();
let currentLevel = 0;
async function lane(client, gateway, index, until, thinkingMs) {
  let first = true;
  let connected;
  const ready = new Promise((resolve) => {
    connected = resolve;
  });
  const done = (async () => {
    do {
      const protocol =
        index < 32
          ? index % 2
            ? "messages"
            : "responses"
          : ["responses", "messages", "websocket"][index % 3];
      const request = await operation(client, gateway, protocol, {
        slow: index >= 32 && index < 44 && protocol !== "websocket",
        initialStart: first,
        laneIndex: index,
        level: currentLevel,
        thinkingMs: first ? thinkingMs : 25,
      });
      await request.connected;
      if (first) {
        connected();
        first = false;
      }
      await request.result;
    } while (now() < until() && !session.failure);
  })();
  void done.catch(stop);
  return { ready, done };
}
const levels = [];
try {
  const baseline = await connect("baseline");
  const load = await connect("load");
  await session.resourcesReady();
  const idle = Object.fromEntries([...series].map(([name, value]) => [name, value.at(-1)]));
  const quiet = {
    at: now(),
    load1: loadavg()[0],
    otherHeavyHolders: 0,
    execution: complete ? "standalone Linux workflow job" : "local diagnostic",
  };
  output("quiet-gate.jsonl", quiet);
  if (complete)
    assert.ok(
      quiet.load1 < 2,
      "Quiet gate failed before the block; do not relabel this timing accepted.",
    );
  let baselineUntil = Infinity;
  const baseLanes = [];
  for (let i = 0; i < 19; i++) {
    const worker = await lane(baseline, "baseline", i, () => baselineUntil, 25);
    baseLanes.push(worker);
    await Promise.race([worker.ready, failed]);
  }
  for (const count of complete ? [200, 400, 800, 1600] : [1600]) {
    currentLevel = count;
    session.level = count;
    const blockStart = now();
    let until = Infinity;
    const workers = [];
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            "Not every operation reached the synthetic upstream before the admission deadline.",
          ),
        ),
      20_000,
    );
    for (let i = 0; i < count; i++) {
      const thinkingMs = i < 32 ? (complete ? (count === 200 ? 600_500 : 31_000) : 100) : 25;
      const worker = await lane(load, "load", i, () => until, thinkingMs);
      workers.push(worker);
      await Promise.race([worker.ready, failed]);
      if (session.failure) throw session.failure;
    }
    const allReached = peer.until(
      () =>
        [...peer.records.values()].filter(
          (record) => record.gateway === "load" && record.initialStart && record.level === count,
        ).length >= count,
    );
    try {
      await Promise.race([allReached, failed]);
    } finally {
      clearTimeout(timeout);
    }
    if (session.failure) throw session.failure;
    const reachedAt = now();
    until = reachedAt + (complete ? (count === 200 ? 30 * 60_000 : 5 * 60_000) : 3000);
    assert.ok(
      (peer.peak.get("load") ?? 0) >= count,
      "Generator promises alone do not establish upstream concurrency.",
    );
    output("milestones.jsonl", {
      phase: "all-upstream",
      count,
      at: reachedAt,
      pendingHeaders: [...peer.records.values()].filter(
        (record) => record.gateway === "load" && !record.firstSentAt,
      ).length,
    });
    const pairs = [];
    for (let pair = 0; pair < (complete ? 40 : 4); pair++) {
      const values = [];
      for (const name of pair % 2 ? ["load", "baseline"] : ["baseline", "load"]) {
        const request = await operation(name === "load" ? load : baseline, name, "responses", {
          probe: true,
          streamMs: 0,
        });
        const record = await request.result;
        // Subtract the peer's measured model-thinking interval, not a configured sleep.
        values.push([
          name,
          record.firstByteAt -
            record.requestedAt -
            (record.upstream.firstSentAt - record.upstream.receivedAt),
        ]);
      }
      const mapped = Object.fromEntries(values);
      pairs.push([mapped.baseline, mapped.load]);
    }
    const timings = complete ? timingEvidence(pairs) : { pairs: pairs.length, diagnostic: true };
    if (complete)
      assert.equal(timings.pass, true, "Added own-path TTFB exceeds the accepted p95/p99 bar.");
    await Promise.all(workers.map((worker) => worker.done));
    if (session.failure) throw session.failure;
    const end = now();
    assert.ok(end >= until, "The plateau must run for its complete requested duration.");
    const result = levelEvidence({
      series: series.get("load"),
      allOperations,
      count,
      blockStart,
      reachedAt,
      end,
      until,
      complete,
      timings,
      upstreamPeak: peer.peak.get("load"),
      idleRss: idle.load.rss,
      idleFds: idle.load.fds,
    });
    levels.push(result);
    output("levels.jsonl", result);
    console.log(
      JSON.stringify({
        phase: "level-complete",
        count,
        operations: result.operations,
        at: new Date().toISOString(),
      }),
    );
  }
  baselineUntil = now();
  await Promise.all(baseLanes.map((worker) => worker.done));
  assert.equal(peer.active.get("load"), 0, "No orphan upstream operation may survive drain.");
  await command(["revoke"], clients.get("load").home);
  const denied = await fetch(`${load.origin}/v1/models`, {
    headers: { authorization: `Bearer ${load.token}` },
  });
  assert.equal(denied.status, 401);
  await denied.body?.cancel();
  const summary = {
    ...fingerprint,
    endedAt: new Date().toISOString(),
    durationMs: now() - start,
    complete,
    pass: complete && !session.failure,
    levels,
    operations: allOperations.length,
    upstreamUnique: peer.records.size,
    noDuplicates: peer.records.size === allOperations.length,
    revoked: true,
    limitations: [
      "Synthetic native peer is not the deployed backend. Separate integrated real-server long-session proof required.",
      "Direct HTTP retains its600000ms pre-header inactivity bound; this proof makes no longer no-byte direct claim.",
    ],
  };
  assert.equal(
    summary.noDuplicates,
    true,
    "An upstream receipt must have one successful protocol terminal.",
  );
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
} catch (error) {
  stop(error);
  writeFileSync(
    join(directory, "summary.json"),
    JSON.stringify(
      {
        ...fingerprint,
        complete: false,
        pass: false,
        error: error.message,
        levels,
        operations: allOperations.length,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = 1;
} finally {
  const cleanup = await session.close();
  writeFileSync(
    join(directory, "cleanup.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      ownedClientsStopped: cleanup.every((result) => result.status === "fulfilled"),
      cleanup: cleanup.map((result) => result.status),
      activeUpstream: Object.fromEntries(peer.active),
    }) + "\n",
  );
}
