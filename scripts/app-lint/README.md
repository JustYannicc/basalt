# App conventions

This is Basalt's CI check for the [Executor app-authoring guide](https://executor.sh/docs/author-an-app).
The upstream contribution is tracked in [executor#2384](https://github.com/UsefulSoftwareCo/executor/issues/2384).

```sh
bun install --cwd scripts/app-lint --frozen-lockfile
node scripts/app-lint/prepare-host.mjs
node scripts/app-lint/check.mjs
node --test scripts/app-lint/*.test.mjs
```

`prepare-host.mjs` reads the public source at `upstream.json` and applies the carried
framework-manifest patches. It uses `gh` authentication in CI. A fully prepared
`.upstream/packages/apps/package.json` takes precedence when present. The lightweight
manifest is bound to the upstream pin and all carried patch bytes.

The checker discovers every directory under `apps/` and every catalog document with
`package` and `files` under `src/catalog/`. Captured `*.published.json` documents are
upstream evidence, not the served app source. They are excluded centrally. No app-name
list or per-file lint exceptions are used. Directory sources use the pool bundler's
shipping exclusions for tests, dependencies and build output. A directory missing its
manifest or entry fails. Catalog source is checked from its actual embedded file bytes.

`node scripts/app-lint/check.mjs --app <directory>` checks an extracted app against the
same host version. It does not deploy or contact the app's external services.

Oxlint 1.89.0 loads `plugin.mjs` through its ESLint-compatible `jsPlugins` API.
`config.mjs` combines the custom rules with built-in restrictions on Effect/SDK imports
and global HTTP. An additional AST rule rejects HTTP reached through aliases of global objects.
The accepted framework forms are deliberately small:

- Import `defineApp`, `mutation`, `query` and `decodeJson` by name from exactly `apps`,
  in the module that calls them. Renaming within the import is supported, such as
  `import { mutation as write } from "apps"; write(...)`.
- The app entry must use `export default defineApp(...)` directly. Parentheses and
  TypeScript expression wrappers are supported; exporting an intermediate app variable
  or forwarding a helper's default export is rejected.
- Call these imported functions directly. Do not assign them to another variable,
  destructure them, return or pass them as values, or re-export them. Default, namespace
  and dynamic imports of `apps`, and exports of its namespace, are rejected.
- Every mutation must own an `approval` option. `approval: undefined` is an explicit
  no-approval choice; operations that need consent can use `always()` from
  `apps/operations/approval`. Local options objects and spreads remain supported when
  their approval property can be proved.

`plain-framework-bindings` rejects unsupported forms at their framework import or
escape, even when a later call supplies approval. Every shipped helper is checked,
so a barrel, default import or dynamic local import cannot hide a forbidden framework
re-export. There is no cross-module binding inference. Ordinary helpers, DTO properties
named `mutation` or `write`, and exported results of checked framework calls remain legal.
Unrelated local helpers may use named, default, namespace or literal dynamic imports.
Computed module discovery and reflection are outside this check's static contract.
Import `QueryContext` and `MutationContext` directly from `apps` too. Local context
type aliases remain supported, but re-exporting those types or aliases is rejected.
CommonJS loading through global `require` or `node:module`/`module` is unsupported.
Use ESM imports in helpers and browser code too.

Use context HTTP and a direct named `decodeJson` import for decoding. Existing context
fetch destructuring and passing a context fetch into an HTTP helper remain supported.
The HTTP alias check considers every assignment. Reusing one alias for both a global
object and a context is rejected, even if the final assignment selects the context.
Destructuring `fetch` from a context is valid. Browser files under `ui/` use browser HTTP;
Effect and SDK imports remain prohibited there.

The Node check requires `type: module` and an exact `dependencies.apps` matching the
prepared Basalt host. Public contributions can retain a separately tested public release
in their captured source. Basalt's served copy must pass the host equality check.
Source outside `ui/public/` must be UTF-8 text, at most 4,096 files and 16 MiB total.
Public assets allow 10,000 files, 32 MB per file and 1 GB total. MB and GB are decimal.

`proof.mjs <case>` temporarily creates a new app folder containing one deliberate
violation, runs the normal app discovery and CI check, and removes the folder afterward.
It deliberately exits with the failing check's status. Run it only in a disposable
checkout. The tests retain small red and green cases for the rules and exact boundaries.
