import assert from "node:assert/strict";
import { test } from "node:test";
import { importSpecifiers } from "./import-specifiers.ts";

test("every real import form is read, in order", () => {
  const source = [
    `import assert from "node:assert/strict";`,
    `import {`,
    `  one,`,
    `  type Two,`,
    `} from "./named.ts";`,
    `import type { Three } from '../types.ts';`,
    `import * as four from "./namespace.ts";`,
    `import "./side-effect.ts";`,
    `export * from "./everything.ts";`,
    `export { five } from "./re-export.ts";`,
    `const six = await import("./dynamic.ts");`,
    `export const seven = () => import('./lazy.ts');`,
  ].join("\n");
  assert.deepEqual(importSpecifiers(source), [
    "node:assert/strict",
    "./named.ts",
    "../types.ts",
    "./namespace.ts",
    "./side-effect.ts",
    "./everything.ts",
    "./re-export.ts",
    "./dynamic.ts",
    "./lazy.ts",
  ]);
});

test("prose in comments and strings is not an import", () => {
  const source = [
    `import { real } from "./real.ts";`,
    `/**`,
    ` * no code path does either (those triggers do not fire in replica mode, which only an import's`,
    ` * insert uses). Every insert into the request table runs this rollup's statement trigger.`,
    ` * import x from "./in-a-comment.ts";`,
    ` */`,
    `// rows from 'the import' are read from "the table"`,
    `export const query = \`SELECT * FROM basalt_model_requests WHERE source = 'import'\`;`,
    `export const note = "rows imported from 'elsewhere'";`,
  ].join("\n");
  assert.deepEqual(importSpecifiers(source), ["./real.ts"]);
});
