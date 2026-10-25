import test from "node:test";
import assert from "node:assert/strict";
import { assertCases } from "./plugin-test-helpers.mjs";
import { checkApps } from "./check.mjs";

const helperBindings = [
  [
    "default import",
    `export { mutation as default } from 'apps';`,
    `import write from './helper.js';`,
  ],
  [
    "dynamic import",
    `export { mutation as write } from 'apps';`,
    `const { write } = await import('./helper.js');`,
  ],
  [
    "destructured export",
    `import * as api from 'apps'; export const { mutation: write } = api;`,
    `import { write } from './helper.js';`,
  ],
  [
    "late assignment",
    `import { mutation } from 'apps'; let write; write = mutation; export { write };`,
    `import { write } from './helper.js';`,
  ],
];

for (const [name, helper, consumer] of helperBindings) {
  test(`helper binding ${name}: real app rejects the unsupported form even with approval`, () => {
    const version = "0.0.1-beta.104-basalt.1";
    const check = (approval) =>
      checkApps(
        [{
          name: "helper-binding",
          files: Object.entries({
            "package.json": JSON.stringify({ type: "module", dependencies: { apps: version } }),
            "helper.ts": helper,
            "index.ts": `import { defineApp, router } from 'apps'; ${consumer}
              const change = write({ ${approval} }, async () => null);
              export default defineApp({}, { tools: router({ change }) });`,
          }).map(([path, content]) => ({ path, bytes: Buffer.from(content) })),
        }],
        version,
      );
    for (const approval of ["", "approval: undefined"]) {
      const errors = check(approval);
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0], /helper\.ts.*plain-framework-bindings.*Use named imports from `apps`/);
    }
  });
}

test("plain framework bindings reject escapes regardless of later approval", () => {
  const unsupported = [
    `import api from 'apps'; api.mutation({ approval: undefined }, () => {});`,
    `import * as api from 'apps'; api.mutation({ approval: undefined }, () => {});`,
    `const { mutation } = await import('apps'); mutation({ approval: undefined }, () => {});`,
    "const api = await import(`apps`); api.query({}, () => {});",
    `export * from 'apps';`,
    `export * as api from 'apps';`,
    `export { mutation as default } from 'apps';`,
    `import { mutation } from 'apps'; export { mutation as write };`,
    `import { mutation } from 'apps'; export default mutation;`,
    `import { mutation } from 'apps'; const dto = { write: mutation }; dto.write({ approval: undefined }, () => {});`,
    `import { mutation } from 'apps'; const [write] = [mutation]; write({ approval: undefined }, () => {});`,
    `import { mutation } from 'apps'; let write; write = mutation; write = () => {}; write({ approval: undefined }, () => {});`,
    `import { mutation } from 'apps'; const write = mutation.bind(null); write({ approval: undefined }, () => {});`,
    `import { mutation } from 'apps'; use(mutation);`,
    `import { mutation } from 'apps'; function factory() { return mutation; }`,
    `import { mutation } from 'apps'; mutation = () => {}; mutation({ approval: undefined }, () => {});`,
    `import { query } from 'apps'; const read = query; read({}, () => {});`,
    `import { defineApp } from 'apps'; let make; make = defineApp; export default make({}, {});`,
    `import { decodeJson } from 'apps'; const decode = decodeJson; decode(response, schema);`,
  ];
  assertCases(
    "plain-framework-bindings",
    unsupported.map((source) => ({ source, expected: "Use named imports from `apps`" })),
  );
});

test("plain named imports, checked helper results and unrelated helpers remain legal", () => {
  const version = "0.0.1-beta.104-basalt.1";
  const sources = {
    "package.json": JSON.stringify({ type: "module", dependencies: { apps: version } }),
    "index.ts": `import { defineApp, mutation as write, router } from 'apps';
      import { approved } from './operations.js';
      import defaultHelper from './helpers.js';
      import * as helpers from './helpers.js';
      const { mutation: dtoMutation, write: dtoWrite } = await import('./helpers.js');
      const { write: unrelated } = helpers;
      defaultHelper(); dtoMutation({}); dtoWrite({}); unrelated({});
      const own = (write as unknown as typeof write)({ approval: undefined }, async () => null);
      export default (defineApp({}, { tools: router({ own, approved }) }) satisfies unknown);`,
    "operations.ts": `import { mutation, decodeJson } from 'apps';
      export const approved = mutation({ approval: undefined }, async (ctx) => {
        const response = await ctx.fetch('https://example.com');
        return decodeJson(response, {});
      });`,
    "helpers.ts": `const dto = { mutation: () => null, write: () => null };
      export const { mutation, write } = dto;
      let ordinary; ordinary = write;
      export default ordinary;`,
  };
  const files = Object.entries(sources).map(([path, source]) => ({
    path,
    bytes: Buffer.from(source),
  }));
  assert.deepEqual(checkApps([{ name: "plain-bindings", files }], version), []);
});

test("default-app-export accepts only a direct named-import call, with TypeScript wrappers", () => {
  assertCases("default-app-export", [
    {
      source: `const { defineApp: make } = { defineApp: () => ({}) }; export default make({}, {});`,
      expected: "imported from",
    },
    {
      source: `import * as api from "apps"; const { defineApp: make } = api; export default make({}, {});`,
      expected: "imported from",
    },
    {
      source: `import { defineApp } from "apps"; let make; make = defineApp; export default make({}, {});`,
      expected: "imported from",
    },
    {
      source: `import { defineApp } from "apps"; export default defineApp({}, {});`,
      expected: null,
    },
    {
      source: `import { defineApp as appFactory } from "apps"; const create = appFactory; const app = create({}, {} as const); export default (app satisfies unknown);`,
      expected: "imported from",
    },
    {
      source: `import * as apps from "apps"; const create = apps.defineApp; export default create({}, {}) as unknown;`,
      expected: "imported from",
    },
    {
      source: `import { defineApp } from "apps"; let factory = defineApp; export default factory({}, {});`,
      expected: "imported from",
    },
    {
      source: `import { defineApp } from "apps"; let factory = defineApp; factory = () => ({}); export default factory({}, {});`,
      expected: "imported from",
    },
    {
      source: `import { defineApp } from "apps"; const app = defineApp({}, {}); export { app as default };`,
      expected: "imported from",
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
      source: `import { defineApp } from "apps"; let requirements; requirements = { accounts: {} }; export default defineApp(requirements, {});`,
      expected: "top-level `accounts` requirements",
    },
    {
      source: `import { query } from "apps"; query({}, (ctx) => { let old; old = ctx; return old.accounts; });`,
      expected: "Read accounts through",
    },
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
      source: `import { defineApp } from "apps"; let requirements = { accounts: {} }; defineApp(requirements, {});`,
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
      source: `import { defineApp } from "apps"; defineApp({}, async (ctx) => { let legacy = ctx; return legacy.accounts; });`,
      expected: "Read accounts through",
    },
    {
      source: `import { defineApp } from "apps"; defineApp({}, async (ctx) => { let legacy = ctx; legacy = {}; return legacy.accounts; });`,
      expected: null,
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
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
  ]);
});

test("mutation-approval rejects indirect bindings and proves explicit options through local spreads", () => {
  assertCases("mutation-approval", [
    {
      source: `const { mutation: write } = { mutation: () => null }; write({}, async () => null);`,
      expected: null,
    },
    {
      files: {
        "index.ts": `import * as helper from "./helper.js"; const { write } = helper; write({}, async () => null);`,
        "helper.ts": `export { mutation as write } from "apps";`,
      },
      entry: "helper.ts",
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      files: {
        "index.ts": `import * as helper from "./helper.js"; helper.write({}, async () => null);`,
        "helper.ts": `export { mutation as write } from "apps";`,
      },
      entry: "helper.ts",
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import * as api from "apps"; const { mutation: write } = api; write({}, async () => null);`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      files: {
        "index.ts": `import { write } from "./helper.js"; write({}, async () => null);`,
        "helper.ts": `import { mutation } from "apps"; export const marker = 1, write = mutation;`,
      },
      entry: "helper.ts",
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import { mutation } from "apps"; let write; write = mutation; write({}, async () => null);`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import { mutation, query } from "apps"; let write; write = mutation; write = query; write({}, async () => null);`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import { mutation } from "apps"; mutation({}, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `import { mutation as write } from "apps"; const mutate = write; mutate({ input: {} }, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import { mutation } from "apps"; let write = mutation; write({}, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import { mutation } from "apps"; let write = mutation; write = () => {}; write({}, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import * as apps from "apps"; apps.mutation({}, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `import * as apps from "apps"; const api = apps; api.mutation({}, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      files: {
        "index.ts": `import { write } from "./actions.js"; write({}, () => {});`,
        "actions.ts": `export { mutation as write } from "apps";`,
      },
      entry: "actions.ts",
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      files: {
        "index.ts": `import { write } from "./barrel.js"; write({}, () => {});`,
        "barrel.ts": `export { write } from "./actions.js";`,
        "actions.ts": `export { mutation as write } from "apps";`,
      },
      entry: "actions.ts",
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `const { mutation: write } = await import("apps"); write({}, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      source: `const apps = await import("apps"); const write = apps.mutation; write({}, () => {});`,
      rule: "plain-framework-bindings",
      expected: "Use named imports from `apps`",
    },
    {
      files: {
        "index.ts": `import { write } from "./helpers.js"; write({}, () => {});`,
        "helpers.ts": `export function write(options: unknown, handler: Function) {}`,
      },
      expected: null,
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
