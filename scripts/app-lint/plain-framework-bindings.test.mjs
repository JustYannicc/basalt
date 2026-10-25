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

test("CommonJS loaders fail in shipped helpers while shadowed require helpers stay legal", () => {
  const version = "0.0.1-beta.104-basalt.1";
  const check = (path, source) => checkApps([{
    name: "commonjs-helper",
    files: Object.entries({
      "package.json": JSON.stringify({ type: "module", dependencies: { apps: version } }),
      "index.ts": `import { defineApp } from 'apps'; export default defineApp({}, {});`,
      [path]: source,
    }).map(([path, content]) => ({ path, bytes: Buffer.from(content) })),
  }], version);
  for (const [path, source] of [
    ["helper.cjs", `const { mutation } = require('apps'); exports.write = mutation({}, () => {});`],
    ["module-helper.cjs", `const { mutation } = module.require('apps'); exports.write = mutation({}, () => {});`],
    ["module-alias.cjs", `const loader = module; const { mutation } = loader.require('apps'); exports.write = mutation({}, () => {});`],
    ["helper.js", `const load = require; const { mutation } = load('apps'); export const write = mutation({}, () => {});`],
    ["helper.ts", `import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('apps');`],
    ["ui/helper.js", `require('apps');`],
    ["ui/module-helper.js", `module.require('apps');`],
  ]) {
    assert.match(check(path, source).join("\n"), /no-restricted-(globals|imports)/);
  }
  assert.deepEqual(check("helper.ts", `function require(name: string) { return name; } export const result = require('ordinary');`), []);
  assert.deepEqual(check("helper.ts", `const module = { require: (name: string) => name }; export const result = module.require('ordinary');`), []);
});

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

test("context type barrels reject at their source while direct imports and local aliases stay legal", () => {
  const version = "0.0.1-beta.104-basalt.1";
  for (const contextType of ["QueryContext", "MutationContext"]) {
    for (const barrel of [
      `export type { ${contextType} as Context } from 'apps';`,
      `import type { ${contextType} as Context } from 'apps'; export type { Context };`,
      `import type { ${contextType} } from 'apps'; export type Context = ${contextType}<{}>;`,
      `import type { ${contextType} } from 'apps'; type Local = ${contextType}<{}>; type Context = Local; export type { Context };`,
    ]) {
      const files = {
        "package.json": JSON.stringify({ type: "module", dependencies: { apps: version } }),
        "types.ts": barrel,
        "helper.ts": `import type { Context } from './types.js'; export function read(ctx: Context) { return ctx.accounts; }`,
        "index.ts": `import { defineApp, query, router } from 'apps'; import { read } from './helper.js'; export default defineApp({}, { tools: router({ read: query({}, ctx => read(ctx)) }) });`,
      };
      const errors = checkApps([{ name: "context-barrel", files: Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.from(content) })) }], version);
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0], /types\.ts.*plain-framework-bindings/);
    }
  }
  assertCases("plain-framework-bindings", [{
    source: `import type { QueryContext as Ctx } from 'apps'; type Context = Ctx<{}>; export function read(ctx: Context) { return ctx.user.accounts; } export type DTO = { accounts: string[] };`,
    expected: null,
  }]);
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

