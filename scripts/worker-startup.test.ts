import assert from "node:assert/strict";
import { test } from "node:test";
import { activeMs, sampled, type CpuProfile } from "./startup-profiler/profile.ts";
import {
  findEntry,
  median,
  reachableModules,
  sizeBudgetBytes,
  startupBudgetMs,
  violations,
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

const profile = (samples: Array<[string, number]>, windowMs = samples.length * 1.5): CpuProfile => ({
  nodes: [...new Set(samples.map(([name]) => name))].map((functionName, id) => ({ id, callFrame: { functionName } })),
  samples: samples.map(([name]) => [...new Set(samples.map(([n]) => n))].indexOf(name)),
  timeDeltas: samples.map(([, ms]) => ms * 1_000),
  startTime: 0,
  endTime: windowMs * 1_000,
});

test("startup CPU counts every non-idle sample, garbage collection included", () => {
  assert.equal(activeMs(profile([["(idle)", 40], ["parse", 1.5], ["(garbage collector)", 1.5], ["(idle)", 1.5]])), 3);
});

test("a profile whose sampler stalled is rejected rather than read as a cheap start", () => {
  // One idle sample across a 150 ms window: the start ran, but nothing sampled it.
  assert.equal(sampled(profile([["(idle)", 143]], 150)), false);
  assert.equal(sampled(profile(Array.from({ length: 60 }, () => ["run", 1.5] as [string, number]), 150)), true);
  // A start too short to sample is still a valid, cheap start.
  assert.equal(sampled(profile([["(idle)", 2.4]], 4.6)), true);
});

test("the median ignores a single slow or stalled run", () => {
  assert.equal(median([69, 70, 192, 68, 71]), 70);
  assert.equal(median([1, 3]), 2);
  // No runs must not read as a pass.
  assert.throws(() => median([]), /No startup measurements/);
});

test("a Worker fails when its median startup or its size crosses the budget", () => {
  const fits = { name: "Api", bytes: 5_322_120, gzipBytes: 1_586_000, startupMs: [69, 70, 400] };
  assert.deepEqual(violations(fits), []);
  const slow = { ...fits, startupMs: [startupBudgetMs + 1, startupBudgetMs + 2, 10] };
  assert.match(violations(slow).join("\n"), /Api starts in 301\.0 ms of CPU \(median\); the budget is 300 ms/);
  const large = { ...fits, bytes: sizeBudgetBytes + 1 };
  assert.match(violations(large).join("\n"), /Api uploads 33554433 bytes/);
});
