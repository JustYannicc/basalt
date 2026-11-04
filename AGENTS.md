# Basalt

Basalt is Signalbox's identity, inference and connectors component. It connects
AI subscriptions and tools to the agents people already use.

## What we never trade away

- **One account, many apps.** A person's work Google account appeared in several
  places under apps' logos, making one account look like several. One account is
  one row with the Google mark; connect once, select anywhere, adding consent
  when needed.
- **Pools select accounts.** The pool screen listed accounts inside the pool,
  obscuring where they belonged. Provider apps connect and manage accounts; pools
  select them, and unlinking preserves the account and its other uses.
- **Push, not pull.** Usage read "last read 5 h" and health checks failed silently
  until someone looked. Freshness and health are the system's job; editable
  workflows keep routine checks quiet and ask when a person is needed.
- **One click.** "Add app" did nothing visible, and a Claude subscription could not
  be added. Setup must complete the person's task and show the result, with
  advanced choices still available.
- **Approved mocks are the acceptance spec.** Work called done from code alone
  failed to match what was approved. Verify each affected interaction live on web
  and phone against the mock, including existing data and recovery.
  When a mock is approved, follow [conformance](e2e/conformance/README.md) to bind
  its revision and every accepted behavior to required public E2E scenarios.

Human in the loop holds pending requests; rules belong to their app or workflow.

## A small glossary

- **Account:** saved access to a service.
- **App:** tools, workflows and an optional screen, declaring the accounts it needs.
- **Pool:** an app selecting model accounts for people and agents.
- **Carry:** a patch applied to pinned dependency source.

## Upstream is a source

Read `upstream.json`, then that exact commit's `AGENTS.md` and relevant guidance.
Search its docs, scripts and fixtures for supported paths before carrying changes.
`npm run prepare:upstream` rebuilds `.upstream` from that pin, applying `patches/`
in filename order. Preserve dependency changes as carries.

A good carry solves one problem through existing mechanisms and proves the public
behavior. Offer reusable fixes upstream; separate product overlays so adopting
the generic fix preserves them.

Merged carries are immutable; corrections get a later carry. Retire only with the
complete replacement and mapped proof; overlays need manual review. See
[releases](docs/releases.md) and the [registry check](scripts/releases/patch-layout.test.ts).

## Ways to hurt yourself

- **Losing state.** Trace saved accounts, links and running workflows. Follow
  [release](docs/releases.md) and [cutover](docs/cutover.md) procedures; production
  repairs and shutdown need explicit authorization.
- **Publishing private context.** Keep public commits, PRs, issues and comments free
  of personal data, hosts, private refs, local paths, thread links and credentials.
  Keep sessions and raw test evidence private.
- **Weakening proof.** Preserve test assertions, coverage and deadlines. Fix the
  product or fixture cause of a failure.

## Follow the whole change

Trace affected entry points, permissions and reverse actions: the Accounts list
and app tabs, shared pools, existing installations, MCP and model clients.
On phones, make essential details usable by touch.

Architecture changes start at [architecture/README.md](architecture/README.md)
and its [glossary](architecture/CONTEXT.md). Put durable carry constraints in the
affected `architecture/model/` file; describe responsibilities, not carry history.
[Fitness checks](scripts/architecture/fitness.test.ts)
enforce boundaries. For behavior, read [pools](docs/pools.md) or
[connectors](docs/connectors.md); for deployment, [self-hosting](docs/self-hosting.md).

## Prove the outcome

Run focused `package.json` checks and applicable [CI gates](.github/workflows/ci.yml).
Authenticated tests use upstream's `apps/hosted/testing/cli.ts` and
`apps/hosted/cloud/scripts/test-accounts.ts`; previews use the password-sign-in
overlay. Keep test accounts dedicated.

Report source checks, merge, deployment and live acceptance separately; keep
acceptance open until proven.
