import assert from "node:assert/strict";
import { test } from "node:test";
import { read, type CpuProfile } from "./startup-profiler/profile.ts";
import {
  findEntry,
  InconclusiveStartup,
  measure,
  median,
  reachableModules,
  sizeBudgetBytes,
  startupBudgetMs,
  violations,
  type WorkerBundle,
} from "./worker-startup.ts";

test("the main module is the one Rolldown didn't name with a content hash", () => {
  const chunks = [
    "api-api-Cr01jjcH.js",
    "api-session-Da1dViX-.js",
    "api-kysely-migration-tables-DFfmKhq--DIOBV7Sd.js",
    "mcp-server-dist--41ADTZu.js",
    "rolldown-runtime-jWApet4k.js",
    "assets/esbuild-eina1h7z.wasm",
  ];
  assert.equal(findEntry(["api-main.js", ...chunks]), "api-main.js");
  // An 8-letter name segment without capitals or digits is not a hash.
  assert.equal(findEntry(["app-data-app-data.js", ...chunks]), "app-data-app-data.js");
  assert.equal(findEntry(["router.js"]), "router.js");
  assert.throws(() => findEntry(chunks), /found none/);
  assert.throws(() => findEntry(["a.js", "b.js"]), /found a\.js, b\.js/);
});

test("only modules the entry reaches are uploaded, through static, dynamic and asset imports", () => {
  const sources: Record<string, string> = {
    "main.js": 'import{t as a}from"./shared-Ab12Cd34.js";const l=()=>import("./lazy-Zz99Yy88.js");',
    "shared-Ab12Cd34.js": 'import"./main.js";export const t=1;',
    "lazy-Zz99Yy88.js": "const w=import(`./assets/tool-Qq11Ww22.wasm`);const x=import(`./${name}.js`);",
    "stale-Old00000.js": "export const old=1;",
    "assets/tool-Qq11Ww22.wasm": "",
  };
  assert.deepEqual(
    reachableModules("main.js", Object.keys(sources), (module) => sources[module]!),
    ["assets/tool-Qq11Ww22.wasm", "lazy-Zz99Yy88.js", "main.js", "shared-Ab12Cd34.js"],
  );
});

/** A profile from samples given as call stacks (`outer>inner`) and the time each one covers. */
const profile = (samples: Array<[string, number]>): CpuProfile => {
  const ids = new Map<string, number>([["(root)", 0]]);
  const nodes: Array<{ id: number; callFrame: { functionName: string }; children: number[] }> = [
    { id: 0, callFrame: { functionName: "(root)" }, children: [] },
  ];
  const node = (stack: string): number => {
    if (ids.has(stack)) return ids.get(stack)!;
    const frames = stack.split(">");
    const parent = frames.length > 1 ? node(frames.slice(0, -1).join(">")) : 0;
    const id = nodes.length;
    ids.set(stack, id);
    nodes.push({ id, callFrame: { functionName: frames.at(-1)! }, children: [] });
    nodes[parent]!.children.push(id);
    return id;
  };
  return {
    nodes,
    samples: samples.map(([stack]) => node(stack)),
    timeDeltas: samples.map(([, ms]) => ms * 1_000),
    startTime: 0,
    endTime: samples.reduce((total, [, ms]) => total + ms, 0) * 1_000,
  };
};

const covered = (...work: Array<[string, number]>) =>
  profile([["(idle)", 40], ["fetch>startupWitnessBefore", 0.1], ...work, ["fetch>startupWitnessAfter>loop", 0.1], ["(idle)", 1]]);

test("startup CPU counts every non-idle sample but the witnesses, garbage collection included", () => {
  const reading = read(covered(["fetch>evaluate", 1.5], ["(garbage collector)", 1.5], ["(idle)", 1.5]));
  assert.deepEqual(reading, { activeMs: 3, conclusive: true });
});

test("a start too cheap to sample is conclusive once the sampler saw both witnesses", () => {
  assert.deepEqual(read(covered()), { activeMs: 0, conclusive: true });
});

test("a start the sampler didn't cover on both sides is inconclusive, never cheap", () => {
  // One idle sample across the whole start: nothing proves the sampler ran.
  assert.equal(read(profile([["(idle)", 143]])).conclusive, false);
  assert.equal(read(profile([["fetch>startupWitnessBefore", 0.1], ["fetch>evaluate", 60]])).conclusive, false);
  assert.equal(read(profile([["fetch>evaluate", 60], ["fetch>startupWitnessAfter", 0.1]])).conclusive, false);
});

const fixture: WorkerBundle = { name: "Fixture", directory: "/fixture", entry: "worker.js", modules: [] };
const starts = (...profiles: CpuProfile[]) => {
  let next = 0;
  return { start: async () => profiles[Math.min(next++, profiles.length - 1)]!, count: () => next };
};

test("a sampler gap that ends in a witness still counts the work it covered", () => {
  // The import ran unsampled; the first sample after it landed in the closing witness.
  const reading = read(profile([["fetch>startupWitnessBefore", 0.1], ["fetch>evaluate", 0.1], ["fetch>startupWitnessAfter", 60], ["fetch>startupWitnessAfter", 0.1]]));
  assert.deepEqual(reading, { activeMs: 60.1, conclusive: true });
});

test("inconclusive starts are retried and reported, not counted", async () => {
  const runs = starts(profile([["(idle)", 60]]), covered(["fetch>evaluate", 70]), covered(["fetch>evaluate", 72]));
  const measurement = await measure(fixture, 2, { start: runs.start, backoffMs: 1 });
  // The closing witness sample right after the work covers 0.1 ms of it.
  assert.deepEqual(measurement.startupMs, [70.1, 72.1]);
  assert.equal(measurement.inconclusive, 1);
  assert.equal(runs.count(), 3);
});

test("a Worker whose every start is inconclusive fails as unknown after retrying with backoff", async () => {
  const runs = starts(profile([["(idle)", 60]]));
  const began = performance.now();
  await assert.rejects(measure(fixture, 2, { start: runs.start, backoffMs: 1 }), (error) => {
    assert.ok(error instanceof InconclusiveStartup);
    assert.match(error.message, /Fixture: the profiler couldn't confirm 7 of 7 starts/);
    return true;
  });
  // Two runs need two of the eight attempts, so the seventh miss is final.
  assert.equal(runs.count(), 7);
  // 1, 2, 4 and 8 ms, then capped at 8 ms; no wait after the final miss.
  assert.ok(performance.now() - began >= 1 + 2 + 4 + 8 * 3);
});

test("the median ignores a single slow run", () => {
  assert.equal(median([69, 70, 192, 68, 71]), 70);
  assert.equal(median([1, 3]), 2);
  // No runs must not read as a pass.
  assert.throws(() => median([]), /No startup measurements/);
});

test("a Worker fails when its median startup or its size crosses the budget", () => {
  const fits = { name: "Api", bytes: 5_322_120, gzipBytes: 1_586_000, startupMs: [69, 70, 400], inconclusive: 0 };
  assert.deepEqual(violations(fits), []);
  const slow = { ...fits, startupMs: [startupBudgetMs + 1, startupBudgetMs + 2, 10] };
  assert.match(violations(slow).join("\n"), /Api starts in 401\.0 ms of CPU \(median\); the budget is 400 ms/);
  const large = { ...fits, bytes: sizeBudgetBytes + 1 };
  assert.match(violations(large).join("\n"), /Api uploads 33554433 bytes/);
});
