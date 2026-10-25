import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = fileURLToPath(new URL(".", import.meta.url));
const oxlint = join(directory, "node_modules/oxlint/bin/oxlint");
const plugin = fileURLToPath(new URL("./plugin.mjs", import.meta.url));

function check(rule, cases) {
  const scratch = mkdtempSync(join(tmpdir(), "executor-app-lint-plugin-"));
  try {
    const config = join(scratch, ".oxlintrc.json");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        plugins: [],
        jsPlugins: [{ name: "executor-apps", specifier: plugin }],
        rules: { [`executor-apps/${rule}`]: "error" },
      }),
    );
    const files = cases.map((item, index) => {
      const name = `case-${index}.ts`;
      writeFileSync(join(scratch, name), item.source);
      return name;
    });
    const result = spawnSync(
      process.execPath,
      [oxlint, "--config", config, "--no-ignore", "--threads", "1", "--format", "json", ...files],
      {
        cwd: scratch,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.ifError(result.error);
    assert.ok([0, 1].includes(result.status), result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    return cases.map((item, index) => {
      const filename = `case-${index}.ts`;
      return {
        expected: item.expected,
        diagnostics: (output.diagnostics ?? []).filter(
          (diagnostic) => basename(diagnostic.filename ?? "") === filename,
        ),
      };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertCases(rule, cases) {
  const results = check(rule, cases);
  for (const [index, result] of results.entries()) {
    if (result.expected === null)
      assert.equal(
        result.diagnostics.length,
        0,
        `${rule} case ${index}: ${JSON.stringify(result.diagnostics)}`,
      );
    else {
      assert.equal(
        result.diagnostics.length,
        1,
        `${rule} case ${index}: ${JSON.stringify(result.diagnostics)}`,
      );
      assert.ok(
        result.diagnostics[0].message.includes(result.expected),
        `${rule} case ${index}: ${result.diagnostics[0].message}`,
      );
    }
  }
}

test("default-app-export follows imported identity, const aliases and TypeScript wrappers", () => {
  assertCases("default-app-export", [
    {
      source: `import { defineApp } from "apps"; export default defineApp({}, {});`,
      expected: null,
    },
    {
      source: `import { defineApp as appFactory } from "apps"; const create = appFactory; const app = create({}, {} as const); export default (app satisfies unknown);`,
      expected: null,
    },
    {
      source: `import * as apps from "apps"; const create = apps.defineApp; export default create({}, {}) as unknown;`,
      expected: null,
    },
    {
      source: `import { defineApp } from "apps"; const app = defineApp({}, {}); export { app as default };`,
      expected: null,
    },
    {
      source: `function defineApp(...args: unknown[]) { return args; } export default defineApp({}, {});`,
      expected: "imported from",
    },
    {
      source: `import { createApp } from "apps"; export default createApp({}, {});`,
      expected: "imported from",
    },
    { source: `export { default } from "./src/index.js";`, expected: "imported from" },
    {
      source: `import { defineApp } from "apps"; const app = defineApp({}, {});`,
      expected: "imported from",
    },
  ]);
});

test("no-legacy-accounts checks only top-level requirements and framework contexts", () => {
  assertCases("no-legacy-accounts", [
    {
      source: `import { defineApp } from "apps"; defineApp({ accounts: {} }, {});`,
      expected: "top-level `accounts` requirements",
    },
    {
      source: `import { defineApp } from "apps"; const legacy = { accounts: {} }; const requirements = legacy; defineApp(requirements, {});`,
      expected: "top-level `accounts` requirements",
    },
    {
      source: `import { defineApp } from "apps"; const base = { accounts: {} }; defineApp({ ...base }, {});`,
      expected: "top-level `accounts` requirements",
    },
    {
      source: `import { defineApp } from "apps"; defineApp({ user: { accounts: {} } }, {});`,
      expected: null,
    },
    {
      source: `import { defineApp } from "apps"; defineApp({ app: { accounts: {} } }, {});`,
      expected: null,
    },
    {
      source: `import { defineApp as makeApp } from "apps"; function helper(makeApp: Function) { makeApp({ accounts: {} }); } makeApp({}, {}); helper(makeApp);`,
      expected: null,
    },
    {
      source: `const dto = { accounts: [] }; function read(value: typeof dto) { return value.accounts; }`,
      expected: null,
    },
    {
      source: `import { defineApp } from "apps"; defineApp({}, async (ctx) => { const { accounts: linked } = ctx; return [ctx.user.accounts, ctx.app.accounts]; });`,
      expected: "Read accounts through",
    },
    {
      source: `import { defineApp } from "apps"; defineApp({}, async (ctx) => ctx.accounts);`,
      expected: "Read accounts through",
    },
    {
      source: `import { query } from "apps"; const handler = (context: unknown) => { const local = context; local.accounts; context.user.accounts; function nested(context: { accounts: string[] }) { return context.accounts; } }; query({}, handler);`,
      expected: "Read accounts through",
    },
    {
      source: `import { query } from "apps"; query({}, ({ accounts, user }) => user.accounts);`,
      expected: "Read accounts through",
    },
    {
      source: `import { query } from "apps"; query({}, (ctx, dto) => dto.accounts);`,
      expected: null,
    },
    {
      source: `import type { QueryContext } from "apps"; type Context = QueryContext<unknown>; function helper(ctx: Context) { return ctx.accounts; } function pool(ctx: QueryContext<unknown>) { return ctx.app.accounts; }`,
      expected: "Read accounts through",
    },
    {
      source: `import * as apps from "apps"; function helper(ctx: apps.QueryContext<unknown>) { return ctx.accounts; } function pool(ctx: apps.QueryContext<unknown>) { return ctx.user.accounts; }`,
      expected: "Read accounts through",
    },
  ]);
});

test("mutation-approval follows imported aliases and proves explicit options through local spreads", () => {
  assertCases("mutation-approval", [
    {
      source: `import { mutation } from "apps"; mutation({}, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `import { mutation as write } from "apps"; const mutate = write; mutate({ input: {} }, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `import * as apps from "apps"; apps.mutation({}, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `import * as apps from "apps"; const api = apps; api.mutation({}, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `import { mutation } from "apps"; mutation({ approval: undefined }, () => {});`,
      expected: null,
    },
    {
      source: `import { mutation } from "apps"; const options = { approval: undefined }; mutation(options, () => {});`,
      expected: null,
    },
    {
      source: `import { mutation } from "apps"; const base = { approval: undefined }; const options = { ...base }; mutation(options, () => {});`,
      expected: null,
    },
    {
      source: `import { mutation } from "apps"; const options = { ...unknown, approval: undefined } satisfies Options; mutation(options, () => {});`,
      expected: null,
    },
    {
      source: `import { mutation } from "apps"; mutation({ ...unknown }, () => {});`,
      expected: "Cannot prove this mutation's `approval`",
    },
    {
      source: `import { mutation } from "apps"; const options = getOptions(); mutation(options, () => {});`,
      expected: "Cannot prove this mutation's `approval`",
    },
    {
      source: `import { mutation as write } from "apps"; function helper(write: Function) { write({}); } write({ approval: undefined }, () => {}); helper(() => {});`,
      expected: null,
    },
    { source: `import { query } from "apps"; query({}, () => {});`, expected: null },
    {
      source: `function mutation(options: unknown, handler: Function) {} mutation({}, () => {});`,
      expected: null,
    },
    {
      source: `import { mutation } from "apps"; mutation({ approval: undefined, ...unknown }, () => {});`,
      expected: "Cannot prove this mutation's `approval`",
    },
    {
      source: `import { mutation } from "apps"; mutation({ ...unknown, approval: undefined }, () => {});`,
      expected: null,
    },
    {
      source: `import { mutation } from "apps"; const options = {}; mutation(options, () => {});`,
      expected: "must explicitly declare `approval`",
    },
  ]);
});
