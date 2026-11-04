# Basalt

Basalt is Signalbox's identity, inference and connectors component. It connects
AI subscriptions and tools to the agents people already use.

## What we never trade away

- **One account, many apps.** Connect once, select anywhere, with additional consent
  when needed. Provider apps connect model accounts; pools select those accounts.
  Unlinking keeps the account and its other uses intact.
- **One click.** Setup does the work for the person, with advanced choices available.
  A manual workaround leaves the ordinary flow unfinished.
- **Push, not pull.** Editable workflows detect problems and ask when someone is
  needed. Human in the loop holds pending requests; rules belong to their app or
  workflow. Keep routine checks silent.

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

Product changes are done when live behavior matches the approved mock on web
and phone, including existing data and recovery. Report source checks, merge,
deployment and live acceptance separately; keep acceptance open until proven.
