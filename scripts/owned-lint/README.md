# Owned lint

Oxlint rules over `scripts/` and `src/`. Upstream code keeps upstream's configuration in
`.upstream/.oxlintrc.jsonc`.
`npm run prepare:upstream` installs the pinned tools.

```sh
npm run lint:owned                      # the check batch-preflight and CI run
npm run lint:owned -- --write-baseline  # record the counts after fixing findings or rebasing
```

The check lints the exact `git ls-files` list, new untracked files included, and fails when
oxlint checks fewer files than it was given: an ignored path reports nothing and would look
clean. It refuses `oxlint-disable` and `eslint-disable` comments that are bare or name an
owned rule.

## Baseline and allowlist

Existing findings are recorded with an exact count per rule and file, so only new ones fail.

- `baseline.json` holds the counts, except for landmines' `no-fixed-sleep`,
  `no-flake-masking`, `strict-msw` and `no-unsignaled-poll`, which keep theirs in the rule
  options in `.oxlintrc.json`. Both are written by `--write-baseline`.
- A count above the record fails and lists the file's findings. A count below it fails until
  `--write-baseline` lowers it.
- With `BASE_SHA` set (CI and batch-preflight), a committed count may not rise above the base
  commit's, and a new file carries no baseline; a renamed file keeps its old count. A rule
  enforced at the base may not be switched off.
- `allowlist.json` records a reasoned exception for `no-direct-cloudflare-api`,
  `no-strict-provider-decode` and landmines' `no-test-doubles` and `no-flake-masking` as
  `{ "count": <findings>, "reason": "<why>" }` per file. `no-test-doubles` takes one only in
  the wire guard's tests (`scripts/release/wire-guard*.test.ts`, enforced in `baseline.ts`): the
  guard under test wraps the global fetch, so the replaced fetch is the transport beneath the
  subject, not a double of a collaborator. Its bodies still fall under the provider-response rule.
  `no-flake-masking` takes one only in `scripts/import-cpamp-bulk.test.ts`, whose ACK test holds
  an upload past 30 s as its proof; its count stays 1, so a second raised timeout there fails. You
  write these entries by hand; `--write-baseline` leaves them alone. With `BASE_SHA`, the
  check lists new or raised entries for review. No entry covers a decode the rule recognises
  as a provider response.

To add or tighten a rule, change `plugin/` with a case in `rules.test.ts` and run
`--write-baseline`. While the rules or their pins differ from the base, a count that rises in
a file this change does not touch is listed for review instead of failing, and
`rules.test.ts` guards the change. The configuration loads exactly the pinned plugins and
takes no `extends`, `overrides` or other keys.

## Basalt rules

`plugin/`, one module per concern. All but `no-direct-cloudflare-api` and the two
`node:test` rules stop a shortcut that broke a production release, and `rules.test.ts`
holds the shipped lines they catch. They are syntactic, because Oxlint
gives JS plugins no type information, and they see one file at a time. A list served from
another module, `this.x` aliases, and answer methods taken off the response
(`const { json } = res`) are not followed.

| Rule | Stops |
|---|---|
| `no-spread-into-provider-request` | A spread, a whole-object copy or a whole object passed as a provider SDK request. A spread target put a JSON body on a GET, and an echoed read-only annotation was refused by a PUT. |
| `no-strict-provider-decode` | `onExcessProperty: "error"` on a provider response. Requests Basalt builds may be strict; any other strict decode needs an allowlist reason. |
| `no-exact-readback-compare` | Whole-value equality of two serialised values, deep equality or `sameProvisioningValue`, in code that calls a provider. Compare through a `*Equivalent` helper in a `*-equivalence.ts` module whose test imports a recorded-shapes module. |
| `no-echo-stub` | A test stand-in that stores or answers with the request it received. Keeping the request to assert on later is fine: make a `const call = { ... }` in the handler, copy single body fields onto it (`call.rpc = body.method`), read it only in `assert`/`expect`, and push it onto a list no response reaches. Any other use of the record (an alias, `this.calls`, a `Map`, a list passed in) is reported, and so is the list once a response can reach it, even as `calls.length`. |
| `no-handwritten-provider-response` | A hand-written `{ success, result }` provider body in a test, outside a recorded-shapes module (`*-shapes.ts`, built from a real, redacted response). |
| `no-direct-cloudflare-api` | Cloudflare SDK calls, Cloudflare API URLs and Wrangler runs or imports. Use Alchemy. |
| `no-discarded-child-output` | A child process whose stderr is ignored, other than git exit-status probes. |
| `no-node-test-doubles` | `node:test` mocks that replace dependency behaviour. Clock control and output capture are allowed. |
| `no-node-test-flake-masking` | `node:test` subtest and hook timeouts, and conditional or permanent skips. |
| `no-alchemy-auto-approve` | In a file that names `alchemy` as a command, any standalone `--yes` or `-y`, however the command is assembled. In beta.80 `--yes` also sets `updateStateStore`, which can redeploy the shared State store; apply and destroy run in-process through the release entry. `alchemy.test.ts` covers workflow steps and package scripts. |

## Third-party rules

[landmines](https://github.com/interfere-inc/landmines) 0.1.0, testing and structure
plugins:

- **Enabled:** `no-test-doubles`, `no-fixed-sleep`, `no-flake-masking`, `no-unsignaled-poll`,
  `strict-msw` and `package-exports`.
- **Never fire here:** `strict-msw` and `no-unsignaled-poll` need MSW and Vitest polling,
  which no owned test uses. `no-test-doubles` sees Vitest and Jest doubles and `globalThis`
  replacements; the `basalt/no-node-test-*` rules cover `node:test`.
- **Off, because they contradict the repo's layout or style:**
  - `colocated-tests` and `test-file-names` would move tests out of `scripts/pool-tests/`,
    whose CI job provides their services.
  - `no-explicit-return-types` would drop the declared return types that Effect's
    diagnostics check error channels against.
  - `no-comments` would remove comments that say why.
