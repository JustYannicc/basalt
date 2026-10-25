import assert from "node:assert/strict";
import { test } from "node:test";
import { checkApps } from "./check.mjs";

const version = "0.0.1-beta.104-basalt.1";
const valid = `import { defineApp, mutation, object, router } from 'apps';
const change = mutation({ input: object({}), approval: undefined }, async (ctx) => ctx.fetch('https://example.com'));
export default defineApp({}, { tools: router({ change }) });`;
const file = (path, content) => ({ path, bytes: Buffer.from(content) });
function app(code = valid, extra = []) {
  return [
    {
      name: "new-app",
      files: [
        file("index.ts", code),
        file("package.json", JSON.stringify({ type: "module", dependencies: { apps: version } })),
        ...extra,
      ],
    },
  ];
}
function messages(code, extra) {
  return checkApps(app(code, extra), version).join("\n");
}

test("valid app passes the real Oxlint binary with explicit approval and context HTTP", () => {
  assert.equal(messages(), "");
});

const red = [
  [
    "default export",
    valid.replace("export default defineApp", "const app = defineApp"),
    /default-app-export/,
  ],
  [
    "unrelated defineApp",
    `const defineApp = () => ({}); export default defineApp();`,
    /default-app-export/,
  ],
  ["Effect import", `import { Effect } from 'effect';\n${valid}`, /no-restricted-imports/],
  ["SDK import", `import { sdk } from '@executor-js/sdk';\n${valid}`, /no-restricted-imports/],
  [
    "legacy requirements",
    valid.replace("defineApp({},", "defineApp({ accounts: {} },"),
    /no-legacy-accounts/,
  ],
  [
    "legacy context",
    valid.replace("ctx.fetch('https://example.com')", "ctx.accounts"),
    /no-legacy-accounts/,
  ],
  [
    "legacy destructuring",
    valid.replace("async (ctx) => ctx.fetch", "async ({ accounts, fetch }) => fetch"),
    /no-legacy-accounts/,
  ],
  ["global HTTP", valid.replace("ctx.fetch(", "fetch("), /no-restricted-globals/],
  ["globalThis HTTP", valid.replace("ctx.fetch(", "globalThis.fetch("), /no-restricted-properties/],
  ["implicit approval", valid.replace(", approval: undefined", ""), /mutation-approval/],
];
for (const [name, code, pattern] of red)
  test(`deliberate red: ${name}`, () => assert.match(messages(code), pattern));

test("destructured context fetch and user/app accounts pass; unrelated DTO accounts stays legal", () => {
  const code = valid.replace("async (ctx) => ctx.fetch", "async ({ fetch, user, app }) => fetch");
  assert.equal(
    messages(code, [
      file("dto.ts", "export const account = (data: { accounts: string[] }) => data.accounts;"),
    ]),
    "",
  );
});

test("browser fetch is valid while forbidden imports remain forbidden in browser files", () => {
  assert.equal(messages(valid, [file("ui/main.tsx", "fetch('/assets/data.json');")]), "");
  assert.match(
    messages(valid, [file("ui/main.tsx", "import { Effect } from 'effect';")]),
    /no-restricted-imports/,
  );
});

test("syntax errors fail the app check rather than passing on empty plugin diagnostics", () => {
  assert.notEqual(messages("export default ???"), "");
});

test("only the root index is the app entry; nested index modules may export helpers", () => {
  assert.equal(messages(valid, [file("src/index.ts", "export const helper = 1;")]), "");
});
