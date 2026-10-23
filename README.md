# Basalt

Basalt is Signalbox's identity, inference and connectors component. It deploys independently so the Signalbox OS can consume its gateways later.

This repository deploys the cloud build of [Executor v2](https://github.com/UsefulSoftwareCo/executor) using its Alchemy stack. Upstream owns sign-in, workspaces, connections and MCP. Basalt supplies deployment configuration and a small public router. The pool backend and the pool app ship separately.

## Public endpoints

| Path               | Handler                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `/` and app routes | Tools service, including its own Google, GitHub and passkey sign-in |
| `/mcp`             | Tools gateway, with upstream authentication                         |
| `/v1` and `/v1/*`  | Reserved model gateway, currently an empty `503` response           |

The router preserves incoming URLs, headers and bodies, and streams responses through a private service binding. OAuth callbacks and discovery documents reach the same tools service. Only the router owns the public custom domain. Cloudflare provisions it from the existing zone through the deploy token.

[brand.ts](brand.ts) holds the current name and host configuration. The broader configurable branding change is separate work. [upstream.json](upstream.json) is the only tools-service commit pin. The generated upstream checkout and dependencies are ignored by Git.

## Deployment

A push to `main` runs [Deploy](.github/workflows/deploy.yml). It validates required secrets, checks the router, fetches the pinned public source, applies carried patches, installs its locked dependencies, builds upstream's framework, then deploys through Alchemy. Database migrations finish before replacement Workers serve traffic. Concurrent production deploys are serialized.

Pull requests run secretless checks and builds through [Check](.github/workflows/ci.yml). A patch that no longer applies or a failed build stops the deployment. The stack keeps Alchemy's Cloudflare state backend, so a new Actions runner sees the existing resources. Production Postgres and R2 resources are retained.

Required services are Cloudflare Workers, R2, Hyperdrive, native Email Sending and Artifacts, PlanetScale Postgres, Google OAuth, and GitHub OAuth. Cloudflare Email Sending delivers sign-in codes, invitations and welcome messages through a sender on the configured sending subdomain. Passkeys use the tools service's defaults.

Autumn billing, Axiom telemetry and Context.dev company suggestions are optional. When unconfigured, Basalt carries an upstream patch that allows product use without billing, exports no Axiom telemetry and skips company suggestions. It never substitutes hosted emulators. Sentry and PostHog configuration belongs to the analytics integration work.

## GitHub Actions secrets

Repository Actions secrets are the deploy input source of truth. Never commit credentials or create a production `.env` file. Alchemy binds runtime copies into Worker secrets, and manages database roles and infrastructure credentials in its protected deployment state.

| Secret name                   | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`       | Account owning the zone and Workers                                     |
| `CLOUDFLARE_API_TOKEN`        | Deploy token                                                            |
| `PLANETSCALE_ORGANIZATION`    | Organization that owns Postgres                                         |
| `PLANETSCALE_API_TOKEN_ID`    | Service token identity                                                  |
| `PLANETSCALE_API_TOKEN`       | Database and role provisioning                                          |
| `GOOGLE_CLIENT_ID`            | Google sign-in OAuth client                                             |
| `GOOGLE_CLIENT_SECRET`        | Google sign-in OAuth secret                                             |
| `AUTH_GITHUB_CLIENT_ID`       | GitHub sign-in OAuth client                                             |
| `AUTH_GITHUB_CLIENT_SECRET`   | GitHub sign-in OAuth secret                                             |
| `BETTER_AUTH_SECRET`          | Session signing                                                         |
| `EXECUTOR_ENCRYPTION_KEY`     | Stored connection credential encryption                                 |
| `MCP_SESSION_KEY_CURRENT`     | Active MCP session signing key                                          |
| `MCP_SESSION_KEY_PREVIOUS`    | Previous MCP session verification key                                   |
| `APP_DOMAIN_CONTROL_SECRET`   | App-domain lifecycle control key                                        |
| `APP_DOMAIN_CONTROLLER_TOKEN` | Scoped DNS/certificate token, required only when app hosting is enabled |

The workflow maps `AUTH_GITHUB_*` to upstream's `GITHUB_*` environment variables because GitHub reserves the latter prefix for Actions secrets. Generated signing and lifecycle secrets are created directly in Actions secrets. Their values never belong in logs, repository files or artifacts.

### Account setup

Create a Cloudflare token for the account owning the configured zone. Account permissions: Workers Scripts Edit, Workers R2 Storage Edit, Hyperdrive Edit, Account Settings Read, Secrets Store Edit, account SSL and Certificates Edit, Workers Observability Edit, and Artifacts Edit. Zone permissions: Zone Read, DNS Edit, Workers Routes Edit, SSL and Certificates Edit, and Email Sending Edit. Enable Workers paid usage and native Email Sending. Alchemy provisions the custom domain and sending subdomain; no manual app DNS record is needed.

Create a PlanetScale organization with Postgres enabled and an organization service token that can provision databases, branches and Postgres roles. Alchemy creates one retained cluster in its configured EU region, with separate runtime and migration roles. The tools service uses its `postgres` database. The pool backend will use a second logical database on that same cluster and connect directly; its provisioning belongs to the pool backend work. Workers use verified TLS Hyperdrive with query caching disabled. Durable Objects retain upstream's direct pooled Postgres connection path to the same EU cluster.

Create a Google OAuth Web application named Signalbox. Its authorized JavaScript origin is the configured public origin. Register `https://app.signalbox.run/api/auth/callback/google` as the exact redirect URI. Allow external Google accounts and add intended users if the consent screen remains in Testing. Sign-in requests only the normal identity scopes.

Create a GitHub OAuth App named Signalbox with homepage `https://app.signalbox.run` and callback `https://app.signalbox.run/api/auth/callback/github`. Upstream requires both social providers at startup.

### App UI hosting

App UI hosting is off in [brand.ts](brand.ts) until its domain and certificate setup is approved. Sign-in, connections and MCP remain available. Apps with screens report that no app domain is configured. The pool app needs this feature before its screens can ship.

Set `appHosting.enabled`, `appHosting.origin` and `appHosting.zone` together to enable a selected domain. The deploy first applies upstream's app-domain foundation, then the cloud application. The scoped controller token comes from `APP_DOMAIN_CONTROLLER_TOKEN` in Actions secrets. It needs DNS Write, Zone Read, and SSL and Certificates Read for that zone. The lifecycle key comes from `APP_DOMAIN_CONTROL_SECRET`.

The managed path needs an existing Advanced Certificate Manager subscription and enables Total TLS. No deploy purchases the subscription. App addresses are `<app>.<organization>.<base>`, so Universal SSL's `*.<base>` certificate is insufficient even on a dedicated domain. A dedicated domain can use the same managed path; a Universal SSL-only path requires a separate addressing change before it can be enabled.

### Rotation and rollback

Keep the encryption key stable. Replacing `EXECUTOR_ENCRYPTION_KEY` without re-encrypting existing credentials makes them unreadable. Rotating `BETTER_AUTH_SECRET` can invalidate sessions.

Rotate MCP signing keys over three deploys. First put a new random signing key in `MCP_SESSION_KEY_PREVIOUS` and deploy. Next swap `MCP_SESSION_KEY_CURRENT` and `MCP_SESSION_KEY_PREVIOUS` and deploy. Finally replace `MCP_SESSION_KEY_PREVIOUS` and deploy again. Both keys are independently generated 32-byte hex strings. Retiring a key causes sessions signed only by it to initialize again.

Roll back by reverting the upstream pin and carried patch changes together and redeploying through Actions. A code rollback does not reverse committed database migrations. Review database changes before updating, take a backup first, and restore it when required by that release. Never destroy the production stack as a rollback step.

## Carried patches

- `0001-optional-cloud-vendors.patch`: absent optional vendors do not require accounts or make external calls.
- `0002-cloud-deployment.patch`: exports the upstream deployment composition, accepts Actions-supplied MCP signing keys, leaves the public domain to the router, configures native mail senders, and sends signed-out visitors to sign-in.
- `0003-eu-durable-objects.patch`: constrains Basalt namespace bindings before native and Effect adapters capture them. Other stacks keep their existing bindings. R2 jurisdiction is set in the deployment patch.
- `0005-app-hosting.patch`: gives the optional app-domain foundation its own stack name and takes controller credentials from Actions.

The public cloud runtime remains upstream code. Each carried patch is applied against the one pinned source. Remove patches when their upstream equivalents are included by a later pin.

## Verification and remaining work

`npm run check` exercises routing and configuration without credentials. `npm run prepare:upstream` prepares the pinned source; `npm run check:upstream` exercises the patched namespace adapter; `npm run typecheck` checks Basalt scripts and router code; `npm run build` builds the upstream framework. Run installs, builds, checks and typechecks through the machine's shared heavy-work limiter when developing on a shared host.

The deploy smoke test checks the signed-out redirect, sign-in page, protected MCP endpoint and reserved model path. It does not prove interactive Google sign-in. The broad upstream source typecheck has existing dependency/type failures; it is not a passing gate here. Release acceptance also requires signing in with Google into an empty workspace and reading back the actual Postgres region, R2 jurisdiction and Durable Object jurisdiction from the deployed resources. Source settings and placement hints alone are insufficient.

The deployment model can be derived from [alchemy.run.ts](alchemy.run.ts). Architecture modeling and its CI checks attach there in separate work.

Artifacts app-source repositories use a separate namespace that the stack creates with immutable EU jurisdiction before exposing the public router. Deploys reject an existing namespace outside the EU. App source and compiled builds are separate stores; both require their own EU configuration.

Cloudflare Workflows persist app step results. Those results can contain user content or tool results, and no Workflow jurisdiction control is currently configured or documented. Inputs and final outputs are encrypted in Postgres separately. This remains an unresolved residency limitation requiring an explicit release decision before merge. The legacy import workflow is disabled for this deployment.
