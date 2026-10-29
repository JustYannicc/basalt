# Signalbox

Your AI subscriptions and your tools, in one place, for every agent you use.

Signalbox pools AI subscriptions like ChatGPT and Claude so you and your team can share them, and connects your agents to the apps you already use: Gmail, Slack, GitHub, Google Drive and more. Set up Claude Code or Codex once and they get both your models and your tools.

[signalbox.run](https://signalbox.run) runs it for you. This repository is the code behind it, so you can run your own.

## What's inside

- **[Executor](https://github.com/UsefulSoftwareCo/executor)** handles sign-in, apps, accounts, connections and MCP. Signalbox runs a pinned release with patches on top ([patches/](patches)).
- **Pools** ([apps/pool](apps/pool)) is an Executor app that shares subscriptions through [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) in a Cloudflare Container.
- **Connectors** ([src/catalog](src/catalog)) are Executor apps for the services Signalbox connects to.
- **[brand.ts](brand.ts)** holds every name, host and link. Change it to make the deployment yours.

## Self-host

You need:

- a Cloudflare account on Workers Paid, with your domain on it
- a PlanetScale organization with Postgres
- a Google OAuth client and a GitHub OAuth app for sign-in

Then:

1. Fork this repository.
2. Edit [brand.ts](brand.ts): your name, host, zone, email domain, links and site operator. Replace the logo files in [public/](public) too.
3. Add the secrets in [docs/self-hosting.md](docs/self-hosting.md) to your fork's GitHub Actions.
4. Push to `main`. Checks run, then Deploy ships it to your domain.

Connectors are optional. Each OAuth connector needs its own OAuth app: see [docs/connectors.md](docs/connectors.md).

## Docs

- [Self-hosting](docs/self-hosting.md): every account and secret, and how deploys work
- [Pools](docs/pools.md): the model gateway, usage and sharing
- [Connectors](docs/connectors.md): Google, Slack, GitHub and the rest
- [Releases](docs/releases.md): how Executor updates and patches land
- [Feedback and telemetry](docs/telemetry.md): what gets reported, and where
- [Architecture](architecture): the system model

## Development

Needs Node 24.3 or newer and [Bun](https://bun.sh).

    npm run prepare:upstream   # fetch the pinned Executor and apply the patches
    npm run check              # tests that need no credentials
    npm run typecheck

## Contributing

Issues and pull requests are welcome. Fixes that belong in Executor go upstream first.
