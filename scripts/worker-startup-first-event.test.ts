import assert from "node:assert/strict";
import { test } from "node:test";
import { firstEventModule, firstEventWorkers, type WorkerBundle } from "./worker-startup.ts";

const bundle = (modules: readonly string[]): WorkerBundle => ({
  name: "Api",
  directory: "/bundle",
  entry: "api-main.js",
  modules: ["api-main.js", ...modules],
});

test("Api's application module is its entry's one relative dynamic import", () => {
  assert.ok(firstEventWorkers.includes("Api"));
  const files: Record<string, string> = {
    "api-main.js":
      'import{a}from"./chunks/api-Schema-x.js";const e=d(()=>import(`./chunks/api-main-B5hd.js`));import(`cloudflare:workflows`);',
  };
  assert.equal(
    firstEventModule(
      bundle(["chunks/api-Schema-x.js", "chunks/api-main-B5hd.js"]),
      (m) => files[m]!,
    ),
    "chunks/api-main-B5hd.js",
  );
});

test("a lazy entry without exactly one uploaded dynamic import fails instead of skipping its application", () => {
  for (const [source, modules] of [
    ["import{a}from'./chunks/x.js';", ["chunks/x.js"]],
    ["import('./chunks/a.js');import('./chunks/b.js');", ["chunks/a.js", "chunks/b.js"]],
    ["import('./chunks/missing.js');", []],
  ] as const)
    assert.throws(
      () => firstEventModule(bundle([...modules]), () => source),
      /Api imports its application on its first event, so its entry must import exactly one uploaded module dynamically/,
    );
});
