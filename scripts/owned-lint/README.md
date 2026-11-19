# Owned lint

Oxlint rules over `scripts/` and `src/`, except `scripts/release-barrier/`, which Alchemy
replaces. Upstream code keeps upstream's configuration in `.upstream/.oxlintrc.jsonc`.
`npm run prepare:upstream` installs the pinned tools.

```sh
npm run lint:owned                      # the check batch-preflight and CI run
npm run lint:owned -- --write-baseline  # record the counts after fixing findings or rebasing
node scripts/owned-lint/check.ts <files> # only these files, against their own entries
```

The check lints the exact `git ls-files` list, new untracked files included, and fails when
oxlint checks fewer files than it was given: an ignored path reports nothing and would look
clean. It refuses `oxlint-disable` and `eslint-disable` comments that are bare or name an
owned rule, including the built-in rules the configuration enables.

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
- `allowlist.json` records a reasoned exception for `no-direct-cloudflare-api` and
  `no-strict-provider-decode` as `{ "count": <findings>, "reason": "<why>" }` per file. You
  write these entries by hand; `--write-baseline` leaves them alone. With `BASE_SHA`, the
  check lists new or raised entries for review. No entry covers a decode the rule recognises
  as a provider response.

To add or tighten a rule, change `plugin/` with a case in `rules.test.ts` and run
`--write-baseline`. While the rules or their pins differ from the base, a count that rises in
a file this change does not touch is listed for review instead of failing, and
`rules.test.ts` guards the change. The configuration loads exactly the pinned plugins and
takes no `extends`, `overrides` or other keys, and every enabled built-in rule names a plugin
listed in `plugins`: oxlint silently skips a rule whose plugin is off. With `BASE_SHA`, changed
options of a rule the base enforced are listed for review, since options decide what a rule
finds.

## Basalt rules

`plugin/`, one module per concern. All but `no-direct-cloudflare-api` and the two
`node:test` rules stop a shortcut that broke a production release, and `rules.test.ts`
holds the shipped lines they catch. They are syntactic: Oxlint
gives JS plugins no type information.

| Rule | Stops |
|---|---|
| `no-spread-into-provider-request` | A spread, a whole-object copy or a whole object passed as a provider SDK request. A spread target put a JSON body on a GET, and an echoed read-only annotation was refused by a PUT. |
| `no-strict-provider-decode` | `onExcessProperty: "error"` on a provider response. Requests Basalt builds may be strict; any other strict decode needs an allowlist reason. |
| `no-exact-readback-compare` | Whole-value equality of two serialised values, deep equality or `sameProvisioningValue`, in code that calls a provider. Compare through a `*Equivalent` helper in a `*-equivalence.ts` module whose test imports a recorded-shapes module. |
| `no-echo-stub` | A test stand-in that stores or answers with the request it received. Keeping the request to assert on later is fine. |
| `no-handwritten-provider-response` | A hand-written `{ success, result }` provider body in a test, outside a recorded-shapes module (`*-shapes.ts`, built from a real, redacted response). |
| `no-direct-cloudflare-api` | Cloudflare SDK calls, Cloudflare API URLs and Wrangler runs or imports. Use Alchemy. |
| `no-discarded-child-output` | A child process whose stderr is ignored, other than git exit-status probes. |
| `no-node-test-doubles` | `node:test` mocks that replace dependency behaviour. Clock control and output capture are allowed. |
| `no-node-test-flake-masking` | `node:test` subtest and hook timeouts, and conditional or permanent skips. |

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

[anti-slop](https://github.com/dmmulroy/anti-slop), vendored in `vendor/anti-slop/` as its
README asks (commit, license and update steps in `vendor/anti-slop/UPSTREAM.md`): the generic
plugin, the Effect plugin, and `oxc/no-accumulating-spread`, the built-in rule it pairs with.
The copy is byte-identical to upstream, and `vendor/manifest.json` records each file's hash.
The full check fails when a recorded file differs, and treats any other file under `vendor/`
as Basalt code, so new code there is linted like the rest. Recorded files are left to upstream:
neither the owned rules nor the fast lane's oxfmt and oxlint check them.

- **Enabled:** every rule but one, all five Effect rules included. `no-runtime-typeof` allows
  `typeof` inside a type predicate, Ultracite's setting: a named predicate is the boundary the
  rule asks for.
- **Off, because layout is oxfmt's:** `require-readable-spacing` requires blank lines oxfmt
  neither adds nor checks (32,581 whitespace-only findings here).
- **Never fire today:** `no-module-mocking` needs `vi.mock` or `jest.mock`, and the only Vitest
  suites here, in `scripts/architecture/`, mock no modules; `node:test`'s `mock.module` is
  `basalt/no-node-test-doubles`'.

## Ultracite

[Ultracite](https://www.ultracite.ai/) 8.3 is the umbrella for both plugins; this is what is
taken from it.

- **Presets, not used:** `ultracite/oxlint/anti-slop` is a bundled build of the same anti-slop
  commit without the Effect plugin or `oxc/no-accumulating-spread`, with
  `require-readable-spacing` on. `ultracite/oxlint/landmines` turns on the landmines rules
  listed as off above. Both are JavaScript configs that need `oxlint.config.ts` and `extends`,
  while this configuration stays JSON that the check pins.
- **Agent rules:** the ones that fit this repository are in `AGENTS.md`: narrowing over
  assertions, input parsed at its boundary, and a fix that changes the code rather than its
  wording. Its formatting, React, accessibility and framework rules are left to oxfmt and to
  upstream's guidance.
- **Post-edit hook:** `.claude/settings.json` and `.codex/hooks.json` use Ultracite's events and
  matchers to run `hook.ts` after each edit. It formats the edited file with oxfmt, then runs
  upstream oxlint and this check on it, as the fast lane will, and hands any failure back to the
  agent. Ultracite's own hook runs its pinned tools instead of the repository's. Codex reads a
  linked worktree's project hooks from the main checkout, and runs them once a person trusts
  them with `/hooks`.
- **Versions:** Ultracite needs oxlint 1.90 and oxfmt 0.71 or later; this package pins oxlint
  1.91. Upstream's oxlint 1.83 and oxfmt 0.68 move with a carry. On this tree that bump changes
  nothing: oxfmt 0.71 reformats no file 0.68 leaves alone, and oxlint 1.90 reports the same
  findings with upstream's configuration.
