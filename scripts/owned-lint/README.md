# Owned lint

Oxlint rules over the code Basalt owns: everything in `scripts/` and `src/` except
`scripts/release-barrier/`, which Alchemy replaces. Upstream code keeps upstream's
configuration in `.upstream/.oxlintrc.jsonc`.

```sh
npm run lint:owned                      # the check batch-preflight and CI run
npm run lint:owned -- --write-baseline  # record the current counts after fixing findings
```

The check runs the pinned `oxlint` on the exact file list from `git ls-files`, including
new untracked files. It fails when oxlint checks fewer files than it was given, because
an ignored path reports nothing and would look clean.

## Baseline

Existing findings are recorded with an exact count per rule and file, so only new ones fail:

- `baseline.json` holds the counts for every rule except landmines' four testing rules
  with their own allowlists (`no-fixed-sleep`, `no-flake-masking`, `strict-msw`,
  `no-unsignaled-poll`), whose counts live in the rule options in `.oxlintrc.json`.
- A count above the recorded one fails and lists the file's findings.
- A count below it also fails until `--write-baseline` lowers it, so the record only shrinks.
- With `BASE_SHA` set (CI and batch-preflight), a committed count may not rise above the
  base commit's. A renamed file may carry its findings; the rule's total may not rise.
- `allowlist.json` exempts a file from one rule, with the reason it is correct there. An
  entry whose file no longer has findings fails.

After rebasing onto changes to the same files, run `--write-baseline` and commit the result.

## Basalt rules

`plugin/`, one module per concern. Each rule stops a shortcut that broke a production release, and
`plugin/basalt.test.ts` holds the shipped lines it catches.

| Rule | Stops |
|---|---|
| `no-spread-into-provider-request` | A spread or a whole object passed as a provider SDK request. A spread target put a JSON body on a GET, and an echoed read-only annotation was refused by a PUT. |
| `no-strict-provider-decode` | `onExcessProperty: "error"` on a provider response. Requests Basalt builds may be strict; any other strict decode needs an allowlist reason. |
| `no-exact-readback-compare` | Whole-value equality (`canonical`, `JSON.stringify`, digests, deep equality, `sameProvisioningValue`) in code that talks to a provider. Compare through a `*Equivalent` helper in a `*-equivalence.ts` module whose test imports a recorded shape. |
| `no-echo-stub` | A test stand-in that answers with the request it received. |
| `no-handwritten-provider-response` | A hand-written `{ success, result }` provider body in a test, outside a recorded-shapes module (`*-shapes.ts`). |
| `no-direct-cloudflare-api` | Cloudflare SDK calls, Cloudflare API URLs and `wrangler` runs. Use Alchemy; an exception needs an allowlist reason. |
| `no-discarded-child-output` | A child process whose stderr is ignored, other than git exit-status probes. |
| `no-node-test-doubles` | `mock.method` and `mock.fn(impl)` from `node:test` replacing dependency behaviour. Clock control and output capture are allowed. |
| `no-node-test-flake-masking` | `node:test` subtest and hook timeouts, and conditional or permanent skips. |
| `no-alchemy-auto-approve` | An `alchemy` command line with `--yes` or `-y`. In beta.80 it also sets `updateStateStore`, which can redeploy the shared State store; apply and destroy run in-process through the release entry. A test covers workflow steps and package scripts. |

## Third-party rules

[landmines](https://github.com/interfere-inc/landmines) 0.1.0, with its testing,
structure and types plugins. Its `no-comments` style rule is off: Basalt keeps comments
that say why. Two of its rules cannot fire here: `strict-msw` and `no-unsignaled-poll`
need MSW and Vitest. `no-test-doubles` recognises Vitest and Jest doubles and `globalThis`
replacements only; the `basalt/no-node-test-*` rules cover the `node:test` forms.
