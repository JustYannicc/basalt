# Basalt

Basalt is Signalbox's identity, inference and connectors component. It deploys independently so the Signalbox OS can consume its gateways later.

This repository deploys the cloud build of [Executor v2](https://github.com/UsefulSoftwareCo/executor) using its Alchemy stack. Upstream owns sign-in, workspaces, connections and MCP. Basalt supplies deployment configuration and a small public router. The model gateway runs the released pool backend. Every person gets their own pool, an app in the tools service that connects subscriptions to that backend.

## Public endpoints

| Path               | Handler                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `/` and app routes | Tools service, including its own Google, GitHub and passkey sign-in |
| Brand files        | The logo, favicon and pool fonts, from [public/](public)            |
| `/mcp`             | Tools gateway, with upstream authentication                         |
| `/v1` and `/v1/*`  | Model gateway, with the pool backend's client-key authentication    |
| `/pool/v1/*`       | Pool control API for pool apps, with a signed per-pool token        |
| `/setup`           | Computer setup page, using the tools service's browser session     |
| `/setup/v1/*`      | Computer list, setup links and paired credential revocation        |
| `/setup/claim/*`   | Single-use credential handoff, expiring after five minutes         |
| `/v8/management/*` and `/v0/management/*` | Not public; 404. Home management uses the internal controller path |

The router preserves incoming URLs, headers and bodies, and streams responses through a private service binding. OAuth callbacks and discovery documents reach the same tools service. Only the router owns the public custom domain. Cloudflare provisions it from the existing zone through the deploy token.

The tools service's Worker also serves its own marketing site, docs and legal pages on every host. The router never forwards them: a signed-out `/` goes to sign-in, and the Docs, Privacy and Terms paths redirect to the brand's own pages once `brand.links` names them, and answer 404 until then. The tools service shows those links only when they are set.

[brand.ts](brand.ts) is the one brand config: the name, logo, host and zone, MCP entry name, OAuth app name, email domain and the brand's own docs and legal links. A rename changes it and the files in [public/](public); every place the tools service shows a name follows. [upstream.json](upstream.json) is the only tools-service commit pin. The generated upstream checkout and dependencies are ignored by Git.

## Deployment

A push to `main` runs [Deploy](.github/workflows/deploy.yml). It validates required secrets, checks the router, fetches the pinned public source, applies carried patches, installs its locked dependencies, builds upstream's framework, then deploys through Alchemy. Database migrations finish before replacement Workers serve traffic. Concurrent production deploys are serialized.

Pull requests run secretless checks and builds through [Check](.github/workflows/ci.yml). A patch that no longer applies or a failed build stops the deployment. The stack keeps Alchemy's Cloudflare state backend, so a new Actions runner sees the existing resources. Production Postgres and R2 resources are retained.

Required services are Cloudflare Workers, R2, Hyperdrive, native Email Sending, Artifacts and Containers, PlanetScale Postgres, Google OAuth, and GitHub OAuth. Cloudflare Email Sending delivers sign-in codes and invitations from no-reply on the configured sending subdomain, under the brand's name. The tools service's own welcome note is not sent under another brand. Passkeys carry the brand's name.

Autumn billing, Axiom telemetry and Context.dev company suggestions are optional. When unconfigured, Basalt carries an upstream patch that allows product use without billing, exports no Axiom telemetry and skips company suggestions. It never substitutes hosted emulators. Sentry and PostHog configuration belongs to the analytics integration work.

## Model gateway

[containers/pool/releases.json](containers/pool/releases.json) pins Home and its node to released artifacts and SHA-256 digests. The image runs both unmodified binaries. Home stores credentials, keys, usage and routing state in its own logical Postgres database. The node handles provider requests. `/v1` responses stream through the router, the pool Worker and one Durable Object without buffering model output.

New conversations use round-robin account selection. Session affinity is enabled with a one-hour TTL, and Home fails over when an account becomes unavailable or reaches quota. These defaults are applied at every container boot without replacing stored accounts or keys.

The stack enforces `jurisdiction: "eu"` and `regions: ["EEUR", "WEUR"]` on the container application. The model gateway creates its one control-plane DO through an EU-jurisdiction namespace. These constrain the container and DO independently. They do not constrain the edge router or pool Worker's execution location. PlanetScale's region remains `eu-central` on the single existing cluster.

A two-hour container inactivity timeout plus five-minute DO alarms and a five-minute Worker cron keep the pool warm while the DO sleeps. A host failure or deployment can still restart it. `X-Signalbox-Pool-Boot` on model responses identifies the supervisor boot so the idle acceptance check can detect a restart. A changed image, database credential or management key restarts the container and reloads its runtime secrets.

Cloudflare's `durable_object` scheduling policy enables disk snapshots but rejects container placement constraints. This deployment uses the `default` policy to enforce EU placement. Faster scheduling and snapshot restore remain unavailable with that constraint. See [placement](https://developers.cloudflare.com/containers/concepts/placement/) and [scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).

## Pools

Each person has their own pool from sign-in, empty at first. Once an organization's owner has a verified email, provisioning installs a private pool app for them from [apps/pool](apps/pool), named after them. Members of someone else's organization get no pool there. Sharing a pool uses the tools service's own app sharing. A deleted pool isn't recreated, and a pool its owner has redeployed isn't upgraded. When Basalt's pool source changes, untouched pools are redeployed by delayed member jobs.

The pool app never holds the pool backend's management key, because anyone who can edit an app's code could read it out. Provisioning signs a pool token with `POOL_APP_SIGNING_KEY`, naming the pool, its owner and its organization. It stores the token as the owner's personal account and links it as the app's account. The app sends it to `/pool/v1/*` along with the caller's id from `ctx.user.id`. The pool Worker verifies the token and scopes every call to that pool's channel group in Home. It refuses changes, such as starting a sign-in, pasting a callback, uploading a login file or removing an account, unless the caller owns the pool. Home management calls stay inside the control-plane DO, on the container's port 8327. The owner can also read `GET /pool/v1/usage` for an exact client session (`session`, the wire `X-Session-ID`) or client key (`key`, Home's key id). It returns one `{id, account, status, at}` row per request, limited to the pool's own accounts.

**v1 limit:** an organization's owners and admins can manage every app in it, so they could edit a pool's code to act as its owner, or copy its token out. That's acceptable for v1: organizations are only the sharing boundary and v1 has no admin roles. A person's pool is created only in the organization they own, and sharing adds people as members, so the only owner or admin who can edit a pool is its owner. A host-signed caller assertion would remove the limit ([executor#2359](https://github.com/UsefulSoftwareCo/executor/issues/2359)). Each pool's record and token name the signing key's version, so rotating `POOL_APP_SIGNING_KEY` (see Rotation and rollback) re-signs and re-links every pool's token and then revokes the old ones.

Connect offers every provider Home can sign in. Home has no endpoint that lists them, so [src/pool/providers.json](src/pool/providers.json) mirrors the provider switch in Home's source at the pinned release. `npm run check:providers` fails when the table drifts from that source. The table only holds ids and display names. The sign-in flow comes from Home's own sign-in link at runtime: a `redirect_uri` on a local address means the person pastes back the address the browser lands on, and anything else is a device sign-in that Home finishes by itself. A login file Home exported can be uploaded instead. Pools take subscriptions only.

Released Home v1.1.6 doesn't say which credential a sign-in saved ([CLIProxyAPIHome#168](https://github.com/router-for-me/CLIProxyAPIHome/pull/168) adds that). The control-plane DO serializes sign-ins for every pool. It holds one lock per provider while an exchange can produce a credential, and it files the one new credential by diffing the credential list. A second sign-in for the same provider waits or gets a retryable `busy`. A device sign-in that stops being polled for 60 seconds is cancelled. If the diff isn't exactly one credential, nothing is added. Switch to the credential id once a Home release includes it.

The pool's screen follows the prototype's Accounts view: each account's usage windows, with a bar for what's left, a mark for how much of the window's time is left, and when it resets, plus capacity per provider. Its fonts are the dashboard's own Geist faces. The pool app bundler copies them from the pinned source into the router's static assets, under `/brand/fonts/`, and the page links them across origins. The app compiler drops font files from npm packages, and binary files in the bundled source would ride in the API Worker. The screen needs app UI hosting, which is off; see below.

Container startup, management endpoints and release validation are documented in [containers/pool](containers/pool/README.md). Local routing and lifecycle tests do not establish live model service: release acceptance also needs test subscriptions, a streamed request, account-affinity and spread checks, and an hour of idle time with the same boot identity.

## Computer setup

The pool's Computers section opens setup on the public host. A short-lived signed intent identifies the pool and caller. Setup currently permits only the caller's own pool. Shared pools and switching to them belong to [signalbox#1412](https://github.com/JustYannicc/signalbox/issues/1412), including revoking computer keys before removing access. The setup host checks the person's verified browser session, creates a tools token pinned to that person's organization through the tools service's native API-key flow, and asks the pool controller for one user-bound model key. The controller creates the pool's channel group before issuing a key. An empty Home channel list would allow every credential, so setup never sends one.

The copied prompt contains a one-time link, never either credential. The link expires after five minutes. The controller stores encrypted credentials and consumes the link durably before returning its instructions. Reads and scheduled cleanup erase expired ciphertext. Browser list and update responses expose only computer metadata. Revocation deletes the model key first, then the tools token, and stays visibly unfinished until both succeed. Rebinding changes the existing key's channel restriction on the server; no client secret changes.

The installer requires Node.js 18 or newer. It respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, backs up each file before writing, and marks its entries using [brand.ts](brand.ts). Claude Code gets the model gateway URL and token, discovery and timeouts. Codex gets a provider with `requires_openai_auth = true` and `X-Api-Key`. Both get the branded MCP server with the tools token. Other providers and servers remain. Undo is a separate paste or installer `--undo`; untouched files return byte for byte, and later unrelated edits survive. Backups and installer state stay in a private directory on that computer.

Codex needs any ChatGPT sign-in. Account-side features follow that account's plan. The Claude desktop app is not covered. The computer turns green after a successful model request scoped to its key and pool, plus an observed successful tools call. Catalog reads and MCP initialization do not count.

Source and local checks are separate from release acceptance. Live acceptance still needs a deployed stack, connected test subscriptions, actual CLI requests with matching usage records, unchanged-secret pool switching, and denial of the next model and tools requests after revocation. App screen hosting is still disabled until its certificate prerequisite is resolved.

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
| `EXECUTOR_OAUTH_GOOGLE_CLIENT_ID` | Hosted Google connector Web client, separate from sign-in |
| `EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET` | Hosted Google connector secret |
| `EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_ID` | Hosted GitHub connector OAuth App client |
| `EXECUTOR_OAUTH_GITHUB_OAUTH_CLIENT_SECRET` | Hosted GitHub connector OAuth App secret |
| `AUTH_GITHUB_CLIENT_ID`       | GitHub sign-in OAuth client                                             |
| `AUTH_GITHUB_CLIENT_SECRET`   | GitHub sign-in OAuth secret                                             |
| `BETTER_AUTH_SECRET`          | Session signing                                                         |
| `EXECUTOR_ENCRYPTION_KEY`     | Stored connection credential encryption                                 |
| `MCP_SESSION_KEY_CURRENT`     | Active MCP session signing key                                          |
| `MCP_SESSION_KEY_PREVIOUS`    | Previous MCP session verification key                                   |
| `POOL_MANAGEMENT_KEY`         | Pool management API and local readiness authentication                 |
| `POOL_APP_SIGNING_KEY`        | 32-byte lowercase hex key that signs pool tokens; shared by provisioning and the pool Worker |
| `POOL_APP_SIGNING_KEY_PREVIOUS` | Optional, only while rotating: the pool Worker still accepts tokens signed with it |
| `APP_DOMAIN_CONTROL_SECRET`   | App-domain lifecycle control key                                        |
| `APP_DOMAIN_CONTROLLER_TOKEN` | Scoped DNS/certificate token, required only when app hosting is enabled |

The workflow maps `AUTH_GITHUB_*` to upstream's `GITHUB_*` environment variables because GitHub reserves the latter prefix for Actions secrets. Generated signing and lifecycle secrets are created directly in Actions secrets. Their values never belong in logs, repository files or artifacts.

### Account setup

Create a Cloudflare token for the account owning the configured zone. Account permissions: Workers Scripts Edit, Workers R2 Storage Edit, Hyperdrive Edit, Account Settings Read, Secrets Store Edit, account SSL and Certificates Edit, Workers Observability Edit, Artifacts Edit, Containers Write and permission to publish container registry images. Zone permissions: Zone Read, DNS Edit, Workers Routes Edit, SSL and Certificates Edit, and Email Sending Edit. Enable Workers paid usage and native Email Sending. Alchemy provisions the custom domain and sending subdomain; no manual app DNS record is needed.

Create a PlanetScale organization with Postgres enabled and an organization service token that can provision databases, branches and Postgres roles. Alchemy creates one retained cluster in its configured EU region, with separate runtime and migration roles. The tools service uses its `postgres` database. The pool backend uses `basalt_pool`, a second logical database on that same cluster, over a direct port 5432 connection with verified TLS. Its login inherits only the database owner role; the owner has no cluster administration privileges. Workers use verified TLS Hyperdrive with query caching disabled. Durable Objects retain upstream's direct pooled Postgres connection path to the same EU cluster.

Create a Google OAuth Web application named after `brand.oauthAppName` (Signalbox). Its authorized JavaScript origin is the configured public origin. Register `https://app.signalbox.run/api/auth/callback/google` as the exact redirect URI. Allow external Google accounts and add intended users if the consent screen remains in Testing. Sign-in requests only the normal identity scopes.

Create a GitHub OAuth App named after `brand.oauthAppName` (Signalbox) with homepage `https://app.signalbox.run` and callback `https://app.signalbox.run/api/auth/callback/github`. Upstream requires both social providers at startup.

### Hosted connectors

The tools service reads `https://app.signalbox.run/catalog/index.json`. A separate read-only Worker serves the official catalog plus operator notices and published additions. App source stays upstream's. Relative icons resolve to the official publisher. The feed and provider notices are outside the tools API Worker bundle; the existing 5.45 MB upload budget stays unchanged.

Create the Google connector as a separate OAuth Web application named Signalbox in a separate Cloud project from sign-in. Choose External audience, publish it as Production, and leave it unverified. Testing status expires refresh tokens after seven days. Register `https://app.signalbox.run/api/oauth/callback` and the authorized JavaScript origin `https://app.signalbox.run`. Enable Gmail, Calendar, Drive, Docs, Sheets and Slides APIs. The consent scope union for these catalog apps is:

- `openid`, `email`, `profile`
- `https://mail.google.com/`
- `https://www.googleapis.com/auth/gmail.settings.basic`
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/presentations`

A connection requests only its selected app's scopes. The connect screen explains the unverified warning, the project's lifetime cap of 100 users and Workspace admin restrictions. Full Gmail and Drive access is intentional. The identity-only sign-in client stays independent of connector grants, consent and rotation. Two clients in one project would still share the project's user cap.

Create a separate GitHub OAuth App named Signalbox with homepage `https://app.signalbox.run` and callback `https://app.signalbox.run/api/oauth/callback`. The official REST app requests `repo`, `read:org`, `workflow`, `gist`, `notifications`, `read:user` and `user:email`. The host's optional `github-oauth` client matches this app; its older GitHub App client remains separate. No app review is required. Organization approval and SAML sign-in can still limit repository access.

Google and GitHub connector credentials use the four `EXECUTOR_OAUTH_*` secrets above. GitHub Actions supplies them and Alchemy writes their runtime copies. No person enters a client secret to connect their account.

Slack is not yet one-click. The official Web API app's OAuth method requests bot scopes and uses a bot token. A hosted personal connection needs a separate user-token method using `user_scope` and `authed_user.access_token`, plus matching health and API credential mappings. Setting `user_scope` beside the existing bot scopes would still create a bot grant. The connect notice states this gap, workspace approval rules, and the unlisted history/replies limit of one request per minute and 15 items per request. The existing unlisted Slack MCP client is unchanged. Do not register a connector Slack app until the user-token method is available.

Run `node scripts/check-connectors.ts --preflight` to verify that the prepared runtime matches `upstream.json`, every carried patch, and the generated pool source. For the local connector proof, prepare upstream's E2E runtime with `bun run e2e:prepare` from `.upstream`, then run `node scripts/check-connectors.ts` from this repository. The pinned E2E collector requires Bun 1.4.2 on PATH. Chromium and an installed Claude Code CLI are required. The runner acquires heavy slots for its install and native CLI processes; start the runner normally so its local servers do not hold a slot.

The proof uses the published Google emulator and a synthetic app with Gmail's scopes. OAuth, token storage, per-person organization-pinned PATs, and MCP authorization use the real pinned runtime. Two users share the hosted app while their account links stay private. Claude loads the production installer configuration, searches the real MCP server, and calls the synthetic Gmail tool; only its model endpoint is simulated. Private diagnostics stay under `.generated/connectors-proof`.

This does not prove the unchanged official Gmail app against Google's production endpoints, or two people sharing a Basalt pool. Those remain live acceptance checks after deployment and provider clients exist. Shipping source does not close that acceptance.

### App UI hosting

App UI hosting is off in [brand.ts](brand.ts) until its domain and certificate setup is approved. Sign-in, connections and MCP remain available. Apps with screens report that no app domain is configured. Pools are installed and work through their tools meanwhile; their screens show once hosting is on, with no other change.

Set `appHosting.enabled`, `appHosting.origin` and `appHosting.zone` together to enable a selected domain. The deploy first applies upstream's app-domain foundation, then the cloud application. The scoped controller token comes from `APP_DOMAIN_CONTROLLER_TOKEN` in Actions secrets. It needs DNS Write, Zone Read, and SSL and Certificates Read for that zone. The lifecycle key comes from `APP_DOMAIN_CONTROL_SECRET`.

The managed path needs an existing Advanced Certificate Manager subscription and enables Total TLS. No deploy purchases the subscription. App addresses are `<app>.<organization>.<base>`, so Universal SSL's `*.<base>` certificate is insufficient even on a dedicated domain. A dedicated domain can use the same managed path; a Universal SSL-only path requires a separate addressing change before it can be enabled.

### Rotation and rollback

Keep the encryption key stable. Replacing `EXECUTOR_ENCRYPTION_KEY` without re-encrypting existing credentials makes them unreadable. Rotating `BETTER_AUTH_SECRET` can invalidate sessions.

Rotate the pool signing key in two deploys. First copy `POOL_APP_SIGNING_KEY` into `POOL_APP_SIGNING_KEY_PREVIOUS`, set a new random 32-byte hex `POOL_APP_SIGNING_KEY` and deploy. About 15 minutes after the deploy, member setup re-signs and re-links every pool's token, so the pool Worker has the new key before any pool uses it. The Worker keeps accepting old tokens meanwhile. Wait at least an hour before you delete `POOL_APP_SIGNING_KEY_PREVIOUS` and deploy again; after that, old tokens stop working. A pool whose token still names the old key at that point gets 401 until its next member setup re-signs it.

Rotate MCP signing keys over three deploys. First put a new random signing key in `MCP_SESSION_KEY_PREVIOUS` and deploy. Next swap `MCP_SESSION_KEY_CURRENT` and `MCP_SESSION_KEY_PREVIOUS` and deploy. Finally replace `MCP_SESSION_KEY_PREVIOUS` and deploy again. Both keys are independently generated 32-byte hex strings. Retiring a key causes sessions signed only by it to initialize again.

Roll back by reverting the upstream pin and carried patch changes together and redeploying through Actions. A code rollback does not reverse committed database migrations. Review database changes before updating, take a backup first, and restore it when required by that release. Never destroy the production stack as a rollback step.

## Carried patches

- `0001-optional-cloud-vendors.patch`: absent optional vendors do not require accounts or make external calls. Offered upstream in [executor#2348](https://github.com/UsefulSoftwareCo/executor/pull/2348).
- `0002-cloud-deployment.patch`: exports the upstream deployment composition, accepts Actions-supplied MCP signing keys, leaves the public domain to the router and configures native mail senders.
- `0003-eu-durable-objects.patch`: constrains Basalt namespace bindings before native and Effect adapters capture them. Other stacks keep their existing bindings. R2 jurisdiction is set in the deployment patch.
- `0004-encrypted-workflow-results.patch`: encrypts persisted Workflow values and callback failures with the existing credential key, and hashes checkpoint names. Replay uses stable per-name occurrence identities.
- `0005-app-hosting.patch`: gives the optional app-domain foundation its own stack name and takes controller credentials from Actions.
- `0006-product-brand.patch`: a configurable product name and logo, so the tools service presents the brand from [brand.ts](brand.ts) in its pages, emails, OAuth and MCP metadata. Offered upstream in [executor#2350](https://github.com/UsefulSoftwareCo/executor/pull/2350). The deployment patch no longer names the email sender; this patch does.
- `0007-product-brand-surfaces.patch`: the built-in app, its account and key, and approvals show the brand's name and logo; Docs, Privacy and Terms links appear only when `brand.links` names them; error and status copy no longer names the tools service. Offered upstream in [executor#2352](https://github.com/UsefulSoftwareCo/executor/pull/2352).
- `0008-caller-identity.patch`: verbatim carry of [executor#2346](https://github.com/UsefulSoftwareCo/executor/pull/2346) at `281f282`, so app code reads the caller's id as `ctx.user.id` (host protocol 14).
- `0009-basalt-framework.patch`: npm has no framework release with caller identity, so production builds serve `apps@0.0.1-beta.104-basalt.1`, built from the patched checkout, through the compiler Worker's framework assets. `framework.release` reports that version, so people's own apps get it too. Drop it with 0008.
- `0010-member-pools.patch`: installs one private pool per organization owner with a verified email, with owner-only upgrades, token repair and signing-key rotation. Demoted owners keep their pools; deleted pools stay deleted.

A patch change that alters workflow step names requires existing runs to be drained before deployment.

The public cloud runtime remains upstream code. Each carried patch is applied against the one pinned source. Remove patches when their upstream equivalents are included by a later pin.

## Verification and remaining work

`npm run check` exercises routing, configuration, the pool control API and the pool screen's helpers without credentials. `npm run check:providers` compares the provider table with the pinned Home source. `npm run check:build` renders the built sign-in pages and the patched emails under the brand and under a swapped name, and fails if either shows the tools service's name. `npm run prepare:upstream` prepares the pinned source; `npm run check:upstream` exercises the patched namespace adapter, empty-state recovery plan and encrypted Workflow replay; `npm run typecheck` checks Basalt scripts, router and the pool Worker; `npm run build` builds the upstream framework and pool Worker. Run installs, builds, checks and typechecks through the machine's shared heavy-work limiter when developing on a shared host.

The deploy smoke test checks the homepage redirect, the branded sign-in page, logo and MCP metadata, the protected MCP endpoint and unauthenticated model-key rejection. It does not prove interactive Google sign-in. The broad upstream source typecheck has existing dependency/type failures; it is not a passing gate here. Release acceptance also requires signing in with Google into an empty workspace and reading back the actual Postgres region, R2 jurisdiction and Durable Object jurisdiction from the deployed resources. Source settings and placement hints alone are insufficient.

The deployment model can be derived from [alchemy.run.ts](alchemy.run.ts). Architecture modeling and its CI checks attach there in separate work.

Artifacts app-source repositories use a separate namespace that the stack creates with immutable EU jurisdiction before exposing the public router. Deploys reject an existing namespace outside the EU. App source and compiled builds are separate stores; both require their own EU configuration.

Cloudflare Workflows have no configured EU jurisdiction. The carried patch encrypts step values, callback failure payloads and terminal results before journal persistence, and hashes checkpoint names. Workflow metadata still has no enforced EU placement. Inputs and final outputs are encrypted in Postgres separately. The legacy import workflow is disabled for this deployment.
