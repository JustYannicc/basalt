# Self-hosting

Every account, secret and deploy step you need to run your own copy.

## Overview

Basalt is Signalbox's identity, inference and connectors component.

This repository deploys the cloud build of [Executor v2](https://github.com/UsefulSoftwareCo/executor) using its Alchemy stack. Upstream owns sign-in, workspaces, connections and MCP. Basalt supplies deployment configuration and a small public router. The model gateway runs the released pool backend. Every person gets their own pool, an app in the tools service that connects subscriptions to that backend.

For existing installations, use the [cutover runbook](cutover.md) and its owner-only login-file importer.

## Public endpoints

| Path               | Handler                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `/` and app routes | Tools service, including its own Google, GitHub and passkey sign-in |
| Brand files        | The logo, favicon and pool fonts, from [public/](../public)            |
| `/mcp`             | Tools gateway, with upstream authentication                         |
| `/v1` and `/v1/*`  | Model gateway, with the pool backend's client-key authentication    |
| `/pool/v1/*`       | Pool control API for pool apps, with a signed per-pool token        |
| `/setup`           | Redirects to the person's Connect page, where setup now lives      |
| `/setup/v1/*`      | Computer list, setup links, per-computer pool switch and paired credential revocation |
| `/share`           | Share page for a pool's owner, using the tools service's browser session |
| `/share/v1/*`      | The pool's people, invitations by email or link, removal, each person's usage and their cap |
| `/setup/claim/*`   | Single-use credential handoff, expiring after five minutes         |
| `/v8/management/*` and `/v0/management/*` | Not public; 404. Home management uses the internal controller path |

The router preserves incoming URLs, headers and bodies, and streams responses through a private service binding. OAuth callbacks and discovery documents reach the same tools service. Only the router owns the public custom domain. Cloudflare provisions it from the existing zone through the deploy token.

The tools service's Worker also serves its own marketing site, docs and legal pages on every host. The router never forwards them: a signed-out `/` goes to sign-in, and the Docs, Privacy and Terms paths redirect to the brand's own pages once `brand.links` names them, and answer 404 until then. The tools service shows those links only when they are set.

The brand's own site is a separate Worker on the zone's apex ([src/site](../src/site)): the home page, Privacy Policy, Terms of Service and legal notice, rendered from `brand.ts` with no scripts, forms or third-party requests. `brand.site` names the operator by entity and region and gives one contact address. Privacy and Terms on the app host redirect there.

[brand.ts](../brand.ts) is the one brand config: the name, logo, host and zone, MCP entry name, OAuth app name, email domain and the brand's own docs and legal links. A rename changes it and the files in [public/](../public); every place the tools service shows a name follows. [upstream.json](../upstream.json) is the only tools-service commit pin. The generated upstream checkout and dependencies are ignored by Git.

## Deployment

A successful Check run for a push to `main` triggers [Deploy](../.github/workflows/deploy.yml) on that exact commit. It validates required secrets, checks the router, fetches the pinned public source, applies carried patches, installs its locked dependencies, builds upstream's framework, then deploys through Alchemy. Database migrations finish before replacement Workers serve traffic. Concurrent production deploys are serialized.

Pull requests run secretless checks and builds through [Check](../.github/workflows/ci.yml). A patch that no longer applies or a failed build stops the deployment. The stack keeps Alchemy's Cloudflare state backend, so a new Actions runner sees the existing resources. Production Postgres and R2 resources are retained.

Required services are Cloudflare Workers, R2, Hyperdrive, native Email Sending, Artifacts and Containers, PlanetScale Postgres, Google OAuth, and GitHub OAuth. Cloudflare Email Sending delivers sign-in codes and invitations from no-reply on the configured sending subdomain, under the brand's name. The tools service's own welcome note is not sent under another brand. Passkeys carry the brand's name.

Autumn billing, Axiom telemetry and Context.dev company suggestions are optional. When unconfigured, Basalt carries an upstream patch that allows product use without billing, exports no Axiom telemetry and skips company suggestions. It never substitutes hosted emulators. Sentry and PostHog configuration belongs to the analytics integration work.

## GitHub Actions secrets

GitHub Actions is authoritative for every deploy input; Alchemy-generated credentials, encrypted Cloudflare state and its bootstrap secrets are managed runtime copies, with plaintext scratch allowed only on ephemeral Actions runners and never in the repo, logs, artifacts or persisted developer storage.

After resetting lost deployment metadata on a healthy state backend, redeploy from Actions to adopt named infrastructure and regenerate database roles.

Redeploy cannot recover a lost or rotated state key; after bootstrap, back up `AlchemyStateStoreEncryptionKey` as the Actions secret `ALCHEMY_STATE_ENCRYPTION_KEY_BACKUP` and restore the original value in Cloudflare before deploying again.

| Secret name                   | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`       | Account owning the zone and Workers                                     |
| `CLOUDFLARE_API_TOKEN`        | Deploy token                                                            |
| `PLANETSCALE_ORGANIZATION`    | Organization that owns Postgres                                         |
| `PLANETSCALE_API_TOKEN_ID`    | Service token identity                                                  |
| `PLANETSCALE_API_TOKEN`       | Database and role provisioning                                          |
| `GOOGLE_CLIENT_ID`            | Google sign-in OAuth client                                             |
| `GOOGLE_CLIENT_SECRET`        | Google sign-in OAuth secret                                             |
| `EXECUTOR_OAUTH_GOOGLE_CLIENT_ID` | Optional hosted Google connector Web client, separate from sign-in |
| `EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET` | Optional hosted Google connector secret |
| `EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_ID` | Optional hosted GitHub connector OAuth App client |
| `EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_SECRET` | Optional hosted GitHub connector OAuth App secret |
| `EXECUTOR_OAUTH_ATLASSIAN_CLIENT_ID` | Optional hosted Atlassian 3LO client for Confluence and Jira |
| `EXECUTOR_OAUTH_ATLASSIAN_CLIENT_SECRET` | Optional hosted Atlassian 3LO secret, supplied with its client ID |
| `EXECUTOR_OAUTH_SLACK_REST_CLIENT_ID` | Optional hosted Slack Web API client, separate from Slack MCP |
| `EXECUTOR_OAUTH_SLACK_REST_CLIENT_SECRET` | Optional hosted Slack Web API secret |
| `EXECUTOR_OAUTH_NOTION_CLIENT_ID` | Optional hosted Notion OAuth client |
| `EXECUTOR_OAUTH_NOTION_CLIENT_SECRET` | Optional hosted Notion OAuth client secret |
| `EXECUTOR_OAUTH_TODOIST_CLIENT_ID` | Optional hosted Todoist OAuth client |
| `EXECUTOR_OAUTH_TODOIST_CLIENT_SECRET` | Optional hosted Todoist OAuth client secret |
| `EXECUTOR_OAUTH_TRELLO_CLIENT_ID` | Optional hosted Trello OAuth client |
| `EXECUTOR_OAUTH_TRELLO_CLIENT_SECRET` | Optional hosted Trello OAuth client secret |
| `EXECUTOR_OAUTH_ZENDESK_CLIENT_ID` | Optional hosted Zendesk OAuth client |
| `EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET` | Optional hosted Zendesk OAuth client secret |
| `ZENDESK_MARKETPLACE_ORGANIZATION_ID` | Optional assigned publisher organization ID, paired with app ID |
| `ZENDESK_MARKETPLACE_APP_ID` | Optional assigned Marketplace app ID, paired with publisher organization ID |
| `AUTH_GITHUB_CLIENT_ID`       | GitHub sign-in OAuth client                                             |
| `AUTH_GITHUB_CLIENT_SECRET`   | GitHub sign-in OAuth secret                                             |
| `BETTER_AUTH_SECRET`          | Session signing                                                         |
| `EXECUTOR_ENCRYPTION_KEY`     | Stored connection credential encryption                                 |
| `MCP_SESSION_KEY_CURRENT`     | Active MCP session signing key                                          |
| `MCP_SESSION_KEY_PREVIOUS`    | Previous MCP session verification key                                   |
| `POOL_MANAGEMENT_KEY`         | Pool management API and local readiness authentication                 |
| `POOL_APP_SIGNING_KEY`        | 32-byte lowercase hex key that signs pool tokens; shared by provisioning and the pool Worker |
| `POOL_APP_SIGNING_KEY_PREVIOUS` | Optional, only while rotating: the pool Worker still accepts tokens signed with it |
| `APP_DOMAIN_CONTROL_SECRET`   | App-domain lifecycle key, needed only by the nested address scheme                                        |
| `APP_DOMAIN_CONTROLLER_TOKEN` | Scoped DNS/certificate token, needed only by the nested address scheme |

The workflow maps `AUTH_GITHUB_*` to upstream's `GITHUB_*` environment variables because GitHub reserves the latter prefix for Actions secrets. Generated signing and lifecycle secrets are created directly in Actions secrets. Their values never belong in logs, repository files or artifacts.

### Account setup

Create a Cloudflare token for the account owning the configured zone. Account permissions: Workers Scripts Edit, Workers R2 Storage Edit, Hyperdrive Edit, Account Settings Read, Secrets Store Edit, account SSL and Certificates Edit, Workers Observability Edit, Artifacts Edit, Containers Write and permission to publish container registry images. Zone permissions: Zone Read, DNS Edit, Workers Routes Edit, SSL and Certificates Edit, and Email Sending Edit. Enable Workers paid usage and native Email Sending. Alchemy provisions the custom domain and sending subdomain; no manual app DNS record is needed.

Create a PlanetScale organization with Postgres enabled and an organization service token that can provision databases, branches and Postgres roles. Alchemy creates one retained cluster in its configured EU region, with separate runtime and migration roles. The tools service uses its `postgres` database. The pool backend uses `basalt_pool`, a second logical database on that same cluster, over a direct port 5432 connection with verified TLS. Its login inherits only the database owner role; the owner has no cluster administration privileges. Each deploy rechecks that database, role and grants with every wait bounded: 10s to connect, 10s for a lock, 20s per statement. Connection, lock and timeout failures get three attempts, so a stuck cluster fails the deploy within about two minutes and names the step it stopped at. The tools service's migration job bounds every wait the same way, on its own session and on Better Auth's: 10s to connect, 5s for a lock, 60s per statement, 75s for a reply on Better Auth's sessions, 150s per run. A lock timeout gets one more run on fresh sessions; nothing else is retried. A failed or stalled run prints the step it stopped at and a report of the job's sessions, what blocks them and the oldest open transactions, without values or login names. It never ends another session. The job writes each step to stderr as it starts and exits by itself after 372s, 20s past its worst case, so the deploy command's 7-minute timeout, which drops stderr, never fires first. Workers use verified TLS Hyperdrive with query caching disabled. The pool Worker checks active model keys through a separate Hyperdrive configuration using the pool runtime role and logical database, with a soft limit of five origin connections. The container keeps its direct connection. Durable Objects retain upstream's direct pooled Postgres connection path to the same EU cluster.

Create a Google OAuth Web application named after `brand.oauthAppName` (Signalbox). Its authorized JavaScript origin is the configured public origin. Register `https://app.signalbox.run/api/auth/callback/google` as the exact redirect URI. Allow external Google accounts and add intended users if the consent screen remains in Testing. Sign-in requests only the normal identity scopes.

Create a GitHub OAuth App named after `brand.oauthAppName` (Signalbox) with homepage `https://app.signalbox.run` and callback `https://app.signalbox.run/api/auth/callback/github`. Upstream requires both social providers at startup.

## App UI hosting

App screens open inside their dashboard page’s **App** tab. Apps with a deployed UI select that tab by default; tool-only apps keep Overview. Explicit tab and tool links keep their destination. **Open in new tab** remains available. The Apps list marks apps with an App screen.

[brand.ts](../brand.ts) enables hosting with `scheme: "opaque"`, `embedded: true` and `origin: "https://signalbox.run"`. Deployment sets `EXECUTOR_APP_UI_BASE_URL`, `EXECUTOR_APP_UI_ADDRESS_SCHEME=opaque` and `EXECUTOR_APP_UI_EMBEDDED=true`. The carried patch defaults upstream to `nested` and embedding off. `EXECUTOR_APP_UI_MANAGED_ROUTE=false` leaves routing to Basalt’s router.

The reserved app-host namespace is exactly `a-<lowercase app UUID>.signalbox.run`: remove `app_` from the immutable app ID and prefix `a-`. Product hosts must never use this namespace. App and organization renames keep the same opaque origin. Resolution yields the immutable app and its current organization before authorization; a later public readable-host mapping can use the same resolution boundary. Public hosting and custom domains are outside this change.

These single-label hosts fit the deployment’s existing `*.signalbox.run` certificate. Opaque mode does not provision per-organization domains, require Advanced Certificate Manager or run the domain controller. Nested mode keeps upstream’s managed-domain behavior. The router forwards only exact opaque app hosts to the tools service’s app-page Worker, before path routing, and never serves dashboard assets or pool/setup APIs on them.

Cloudflare [does not support infix wildcards in routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), so `a-*.signalbox.run/*` cannot be a route. The deployment uses a proxied wildcard DNS record and `*.signalbox.run/*`; explicit product-host bypasses preserve existing custom-domain origins. The router returns an empty 404 for other wildcard hosts. `appHosting.bypassHosts` lists custom-domain product hosts without their own more-specific zone route. More-specific existing routes remain untouched. The new DNS record and bypass resources refuse adoption, so they cannot replace existing records or routes. Existing exact DNS records, including email and verification records, keep their normal precedence over wildcard DNS. Live DNS, route precedence and certificate behavior remain deployment acceptance work.

Embedded app responses allow only the dashboard origin in CSP `frame-ancestors`. The dashboard’s `/app-auth` route allows `'self'`; other dashboard documents retain `'none'` and `X-Frame-Options: DENY`. The iframe has the approved sandbox permissions, `clipboard-write`, and no referrer. A host-owned message confirms loading; a missed deadline offers Retry. Router-served HTML, including `/setup`, `/share`, static pages and error pages, also sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The tools service’s `/app-auth` response is the only same-origin framing exception.

The app origin, dashboard and redirect callback share the HTTPS `signalbox.run` site while remaining different origins. [WebKit defines a site as a registrable domain and its subdomains](https://webkit.org/tracking-prevention/), so Safari’s third-party cookie block does not make these app frames third-party. This is a documented expectation, not a Safari device test. Existing app sessions remain HttpOnly, Secure, SameSite=Lax `__Host-executor_app` cookies without a Domain attribute. Dashboard authentication uses Better Auth’s supported `advanced.cookiePrefix`, `useSecureCookies` and default attributes so every core and plugin cookie starts with `__Host-executor-hosted.`, has `Path=/` and `Secure`, and has no Domain attribute. This replaces `__Secure-executor-hosted.*`; old names are never read. Existing browser sessions do not survive this name change, so people sign in once again. Session rows and bearer credentials are unchanged. Dashboard routing hints, last-organization memory, time-zone preferences, passkey prompts and anonymous visitor cookies also use host-only names on HTTPS. Cross-subdomain anonymous signup attribution stops; same-origin attribution remains. Same-site does not allow app code to read the dashboard DOM, host-only dashboard cookies or another app’s session. The server also checks the exact request origin and session target. Isolated test stages keep hosting disabled until they have their own app DNS and certificate configuration.

## Rotation and rollback

Keep the encryption key stable. Replacing `EXECUTOR_ENCRYPTION_KEY` without re-encrypting existing credentials makes them unreadable. Rotating `BETTER_AUTH_SECRET` can invalidate sessions.

Rotate the pool signing key in two deploys. First copy `POOL_APP_SIGNING_KEY` into `POOL_APP_SIGNING_KEY_PREVIOUS`, set a new random 32-byte hex `POOL_APP_SIGNING_KEY` and deploy. About 15 minutes after the deploy, member setup re-signs and re-links every pool's token, so the pool Worker has the new key before any pool uses it. The Worker keeps accepting old tokens meanwhile. Wait at least an hour before you delete `POOL_APP_SIGNING_KEY_PREVIOUS` and deploy again; after that, old tokens stop working. A pool whose token still names the old key at that point gets 401 until its next member setup re-signs it.

Rotate MCP signing keys over three deploys. First put a new random signing key in `MCP_SESSION_KEY_PREVIOUS` and deploy. Next swap `MCP_SESSION_KEY_CURRENT` and `MCP_SESSION_KEY_PREVIOUS` and deploy. Finally replace `MCP_SESSION_KEY_PREVIOUS` and deploy again. Both keys are independently generated 32-byte hex strings. Retiring a key causes sessions signed only by it to initialize again.

Roll back by reverting the upstream pin and carried patch changes together and redeploying through Actions. A code rollback does not reverse committed database migrations. Review database changes before updating, take a backup first, and restore it when required by that release. Never destroy the production stack as a rollback step.
