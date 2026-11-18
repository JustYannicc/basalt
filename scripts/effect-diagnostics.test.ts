import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { baseProblems, baselineProblems, gatedRules } from "./effect-diagnostics.ts";
import {
  countSuppressions,
  inScope,
  parseCompilerOutput,
  root,
} from "./effect-diagnostics-record.ts";

test("a rise fails, a fall fails until the baseline is lowered, and deleted files never fail", () => {
  const baseline = { schemaSync: { "src/a.ts": 2, "src/gone.ts": 4 } };
  const exists = (file: string) => file !== "src/gone.ts";
  assert.deepEqual(baselineProblems({ schemaSync: { "src/a.ts": 2 } }, baseline, exists), []);
  const rise = baselineProblems({ schemaSync: { "src/a.ts": 3 } }, baseline, exists);
  assert.equal(rise.length, 1);
  assert.match(rise[0]!, /src\/a\.ts: schemaSync rose from 2 to 3/);
  const fall = baselineProblems({ schemaSync: { "src/a.ts": 1 } }, baseline, exists);
  assert.equal(fall.length, 1);
  assert.match(
    fall[0]!,
    /fell from 2 to 1\. Lower the baseline with node scripts\/effect-diagnostics\.ts --write/,
  );
  const newRule = baselineProblems(
    { floatingEffect: { "src/b.ts": 1 }, ...baseline },
    baseline,
    () => true,
  );
  assert.ok(
    newRule.some((problem) => problem.includes("src/b.ts: floatingEffect rose from 0 to 1")),
  );
});

test("the committed baseline may only shrink against the base commit; counts move only with code", () => {
  const base = { schemaSync: { "src/a.ts": 2, "src/b.ts": 1 } };
  const baseFiles = new Set(["src/a.ts", "src/b.ts"]);
  assert.deepEqual(baseProblems({ schemaSync: { "src/a.ts": 1 } }, base, baseFiles), []);
  // A split takes the counts its git copy source lost.
  const split = new Map([["src/a-part.ts", ["src/a.ts"]]]);
  assert.deepEqual(
    baseProblems({ schemaSync: { "src/a.ts": 1, "src/a-part.ts": 1 } }, base, baseFiles, split),
    [],
  );
  assert.match(
    baseProblems(
      { schemaSync: { "src/a.ts": 1, "src/a-part.ts": 2 } },
      base,
      baseFiles,
      split,
    ).join("\n"),
    /raises src\/a-part\.ts schemaSync from 1 to 2/,
  );
  // Fixing a site does not pay for a new one elsewhere.
  const traded = baseProblems(
    { schemaSync: { "src/a.ts": 1, "src/b.ts": 1, "src/new.ts": 1 } },
    base,
    baseFiles,
  );
  assert.match(traded.join("\n"), /raises src\/new\.ts schemaSync from 0 to 1/);
  const raised = baseProblems({ schemaSync: { "src/a.ts": 1, "src/b.ts": 2 } }, base, baseFiles);
  assert.match(raised.join("\n"), /raises src\/b\.ts schemaSync from 1 to 2/);
  const grown = baseProblems({ schemaSync: { "src/a.ts": 3, "src/b.ts": 1 } }, base, baseFiles);
  assert.match(grown.join("\n"), /raises the schemaSync total from 3 to 4/);
});

test("compiler output keeps multi-line messages, rule names and the program's files apart", () => {
  const output = [
    "src/a.ts(3,5): error TS377030: Having an unknown error type is not useful.",
    "Only service identifiers should appear here. effect(anyUnknownInErrorContext)",
    "src/b.ts(1,1): error TS2307: Cannot find module './gen.ts'.",
    join(root, "scripts/effect-diagnostics.ts"),
  ].join("\n");
  const parsed = parseCompilerOutput(output, root);
  assert.deepEqual(
    parsed.diagnostics.map((d) => [d.file, d.line, d.column, d.code, d.rule]),
    [
      ["src/a.ts", 3, 5, 377030, "anyUnknownInErrorContext"],
      ["src/b.ts", 1, 1, 2307, "TS2307"],
    ],
  );
  assert.deepEqual(parsed.files, ["scripts/effect-diagnostics.ts"]);
});

test("the gate covers Basalt's own code by path, not by a list", () => {
  for (const file of [
    "src/pool/x.ts",
    "scripts/deploy-safety/new.ts",
    "scripts/cutover/check.mts",
    "src/setup/a.tsx",
  ])
    assert.ok(inScope(file), file);
  for (const file of [
    "scripts/release-barrier/x.ts",
    "e2e/x.ts",
    "src/setup/files.d.mts",
    "src/drive/shared/node_modules/effect/x.ts",
  ])
    assert.ok(!inScope(file), file);
});

test("comments that hide diagnostics are counted", () => {
  const nocheck = "// @ts-" + "nocheck";
  const directive = "/* @effect-" + "diagnostics floatingEffect:off */";
  const nextLine = "// @effect-" + "diagnostics-next-line *:off";
  assert.equal(
    countSuppressions([nocheck, directive, nextLine, "const at = '@ts-ignore';"].join("\n")),
    3,
  );
});

test("the pinned compiler raises every seeded gated rule through tsconfig.effect.json", () => {
  const seeded: Record<string, string> = {
    floatingEffect: "export const a = Effect.gen(function* () { Effect.log('x'); });",
    globalErrorInEffectFailure: "export const b = Effect.fail(new Error('x'));",
    unknownInEffectCatch:
      "export const c = Effect.tryPromise({ try: () => Promise.resolve(1), catch: (e) => e });",
    anyUnknownInErrorContext: "export const d: Effect.Effect<number, unknown> = Effect.succeed(1);",
    tryCatchInEffectGen:
      "export const e = Effect.gen(function* () { try { yield* Effect.log('x'); } catch { return 1; } return 2; });",
    schemaSync: "export const f = Schema.decodeUnknownSync(S)({ a: 'x' });",
    schemaSyncInEffect:
      "export const g = Effect.gen(function* () { const v = Schema.decodeUnknownSync(S)({ a: 'x' }); yield* Effect.log(v); });",
    missingEffectContext:
      "export const h: Effect.Effect<number> = Effect.gen(function* () { const dep = yield* Dep; return dep.n; });",
    missingEffectError: "export const i: Effect.Effect<number> = Effect.fail(new Fail());",
    missingLayerContext:
      "export const j: Layer.Layer<Dep> = Layer.effect(Dep, Effect.gen(function* () { return { n: (yield* Dep).n }; }));",
    globalFetchInEffect:
      "export const k = Effect.gen(function* () { yield* Effect.promise(() => fetch('https://example.invalid')); });",
    globalConsoleInEffect: "export const l = Effect.gen(function* () { console.log('x'); });",
    effectSucceedWithVoid: "export const m = Effect.succeed(undefined);",
    catchToOrElseSucceed:
      "export const n = Effect.fail(new Fail()).pipe(Effect.catch(() => Effect.succeed(1)));",
    allOfMapToForEach: "export const o = Effect.all([1, 2].map((x) => Effect.succeed(x)));",
    syncToSucceed: "export const p = Effect.sync(() => 1);",
    flatMapToMap:
      "export const q = Effect.succeed(1).pipe(Effect.flatMap((x) => Effect.succeed(x + 1)));",
    unnecessaryPipe: "export const r = Effect.succeed(1).pipe();",
    runOfExitToRunExit: "export const s = Effect.runPromise(Effect.exit(Effect.succeed(1)));",
  };
  mkdirSync(join(root, ".generated"), { recursive: true });
  const directory = mkdtempSync(join(root, ".generated", "effect-diagnostics-test-"));
  try {
    const source = [
      'import { Context, Data, Effect, Layer, Schema } from "effect";',
      "const S = Schema.Struct({ a: Schema.String });",
      'class Dep extends Context.Service<Dep, { readonly n: number }>()("Dep") {}',
      'class Fail extends Data.TaggedError("Fail")<{}> {}',
      ...Object.values(seeded),
    ].join("\n");
    writeFileSync(join(directory, "seed.ts"), source);
    const config = { extends: "../../tsconfig.json", include: ["seed.ts"] };
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify(config));
    const result = spawnSync(
      join(root, ".upstream/node_modules/.bin/tsc-rs"),
      ["--noEmit", "--pretty", "false", "-p", join(directory, "tsconfig.json")],
      { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 },
    );
    assert.equal(result.error, undefined);
    const { diagnostics } = parseCompilerOutput(result.stdout, root);
    assert.deepEqual(
      diagnostics.filter((d) => d.rule === "unknownRuleName"),
      [],
    );
    const raised = new Set(diagnostics.filter((d) => d.severity === "error").map((d) => d.rule));
    for (const rule of Object.keys(seeded)) {
      assert.ok(gatedRules.includes(rule as (typeof gatedRules)[number]), rule);
      assert.ok(raised.has(rule), `${rule} was not raised at error:\n${result.stdout}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
