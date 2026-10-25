import test from "node:test";
import { assertCases } from "./plugin-test-helpers.mjs";

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
      source: `import { defineApp } from "apps"; let factory = defineApp; export default factory({}, {});`,
      expected: null,
    },
    {
      source: `import { defineApp } from "apps"; let factory = defineApp; factory = () => ({}); export default factory({}, {});`,
      expected: "imported from",
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
      source: `import { mutation } from "apps"; let write = mutation; write({}, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `import { mutation } from "apps"; let write = mutation; write = () => {}; write({}, () => {});`,
      expected: "Cannot prove this mutation's `approval`",
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
      files: {
        "index.ts": `import { write } from "./actions.js"; write({}, () => {});`,
        "actions.ts": `export { mutation as write } from "apps";`,
      },
      expected: "must explicitly declare `approval`",
    },
    {
      files: {
        "index.ts": `import { write } from "./barrel.js"; write({}, () => {});`,
        "barrel.ts": `export { write } from "./actions.js";`,
        "actions.ts": `export { mutation as write } from "apps";`,
      },
      expected: "must explicitly declare `approval`",
    },
    {
      source: `const { mutation: write } = await import("apps"); write({}, () => {});`,
      expected: "must explicitly declare `approval`",
    },
    {
      source: `const apps = await import("apps"); const write = apps.mutation; write({}, () => {});`,
      expected: "must explicitly declare `approval`",
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
