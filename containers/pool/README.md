# CLIProxyAPI pool container

This image runs one Home control plane and one CLIProxyAPI node in one container. Deploy it as a Cloudflare Container with jurisdiction <code>eu</code>, regions <code>EEUR/WEUR</code>, and the default scheduling policy. The parent app owns that placement and keeps the container warm.

Cloudflare's faster <code>durable_object</code> scheduling and snapshot policy is unavailable with EU placement constraints. The [placement documentation](https://developers.cloudflare.com/containers/concepts/placement/) restricts those constraints to the default policy; the [scheduling-policy documentation](https://developers.cloudflare.com/containers/concepts/scheduling-policy/) describes the faster policy and its snapshots. Enforced EU placement takes priority. Warmth replaces fast wake: a five-minute alarm and scheduled trigger refresh the two-hour inactivity timeout, so ordinary quiet periods do not put the container to sleep. The Durable Object has a separate EU jurisdiction constraint. The routing Worker has no enforced location.

Deployments and crashes can still restart the container. Startup waits up to 180 seconds for Home and the node to become healthy; unsuccessful requests return <code>503</code> with <code>Retry-After: 5</code>, and the next alarm retries recovery. The timeout is a bound on one startup attempt, not a measured recovery time or availability guarantee. Live acceptance must record the first streamed response after at least one hour without client traffic, verify the boot identity stayed unchanged, and separately measure elapsed time from an observed deploy/crash restart until <code>/v1</code> answers again. Those production measurements remain pending deployment.

The upstream artifact pins and SHA-256 values live in releases.json. The build downloads the unmodified Home and node Linux no-plugin release assets, verifies each digest, and copies their executables and licenses into the runtime image.

## Build context

The Docker build context is this directory:

<pre><code>docker build -t basalt-pool:local containers/pool</code></pre>

## Runtime contract

Required environment:

- <code>POOL_DATABASE_URL</code>: direct PostgreSQL URI for Home's dedicated logical database. The URI is written unchanged into a YAML scalar under /dev/shm; reserved URI characters must already be percent-encoded. Query options such as <code>options=-c%20role%3Dbasalt_pool_owner</code> are preserved.
- <code>POOL_MANAGEMENT_KEY</code>: Home management key. The supervisor maps it to Home's <code>MANAGEMENT_PASSWORD</code> environment override and uses it for local Management API calls and readiness authentication.

Optional environment:

- <code>POOL_MANAGEMENT_ALLOW_REMOTE</code>: defaults to <code>false</code>. The parent app sets <code>true</code> for Home management over the private controller path. The public router and pool Worker reject direct <code>/v0/management/*</code> and <code>/v8/management/*</code> requests. The Durable Object retains the internal mapping to port 8327; Home still requires the management key.

The supervisor verifies that /dev/shm is tmpfs before writing secrets. It keeps the PostgreSQL DSN, exchange config, Home JWT, and node certificate material in memory-backed storage. It imports the small exchange config only after Home exits with its explicit empty-database-config diagnostic, then deletes that file. Normal restarts use Home's database as the authority and PATCH only server port, routing, and remote-management fields. The patch does not include provider credentials, client API keys, or the stored management key.

Home runs its PostgreSQL migrations at startup. The database role must be able to create and migrate Home tables in the configured database/schema. The Home PostgreSQL URI accepts a direct provider URI; environment placeholders inside a YAML file are not expanded.

Home's Management API uses the <code>MANAGEMENT_PASSWORD</code> environment override, so no first-user or first-admin bootstrap is needed. The node enrollment endpoint issues a Home JWT; the node uses it to obtain its unique mTLS certificate. Temporary JWT and certificate files remain in /dev/shm. Each supervisor boot uses a separate memory-backed node home and enrolls a fresh node identity. This prevents an old cached certificate from being reused with a new enrollment JWT; old certificate records are not automatically revoked.

## Ports and readiness

- <code>8317</code>: CLIProxyAPI client API.
- <code>8327</code>: Home UI and Management API.
- <code>8318</code>: readiness endpoint.

<code>GET /ready</code> on port <code>8318</code> requires <code>Authorization: Bearer &lt;POOL_MANAGEMENT_KEY&gt;</code>. It returns exactly <code>{"boot_id":"...","started_at":"..."}</code> with HTTP <code>200</code> only while both processes are live, the CPA health endpoint is healthy, and Home reports this node as healthy. It returns the same two fields with HTTP <code>503</code> otherwise. The values are generated for each supervisor process. No secret, credential, user, node address, or database detail is included.

The parent router owns <code>X-Signalbox-Pool-Boot</code>; it can read <code>boot_id</code> from /ready and attach that value to normal model responses for the warm-persistence proof.

The bounded unit tests use Python's standard library. From the repository root, run <code>python3 -m unittest containers.pool.test_bootstrap</code>. The parent owns the Docker/PostgreSQL integration run.

## Routing and model catalog

The image explicitly sets round-robin selection, session affinity with a one-hour TTL, and three additional request-retry rounds. It tries all eligible credentials per round and caps cooldown wait between rounds at 30 seconds. Home owns quota/error cooldown and automatically fails over when a bound credential becomes unavailable. Upstream defaults are round-robin, affinity disabled, and three retry rounds.

Home's public <code>GET /user/models</code> returns every model the cluster can currently serve, with literal model IDs, providers, modalities, and published capabilities. It does not provide a complete service-tier support matrix.

Authenticated <code>GET /user/models/accessible</code> returns the subset allowed by the user's API keys and, when pricing is configured, <code>pricing.providers[].tiers[].service_tier</code>. These values describe configured pricing rules, not a guaranteed complete list of upstream speed options. Do not infer an unlisted speed tier from a model ID.

Authenticated <code>GET /v1/models</code> lists the models allowed by the calling key. Clients that consume the richer backend catalog can request <code>GET /v1/models?client_version=cpa</code>. Basalt passes both responses through unchanged. It has no provider-specific tier table or catalog adapter.

Known limitation: the pinned backend does not expose a complete non-Codex speed-tier matrix, including Claude Fast discovery. Basalt exposes whatever the backend can report today; it does not infer missing tiers or account eligibility. The gap is tracked in [CLIProxyAPI#6928](https://github.com/router-for-me/CLIProxyAPI/issues/6928) and [signalbox#1409](https://github.com/JustYannicc/signalbox/issues/1409). This limitation is accepted for the current release and does not hold the container, routing, or affinity delivery.

## Compatibility caveat

The selected Home release declares a CLIProxyAPI module dependency older than the separately pinned node release. Upstream publishes no compatibility matrix for this pair. The local Docker/PostgreSQL integration exercises bootstrap, a synthetic provider stream, affinity, spreading, quota failover and restart persistence with this pair. Real-subscription acceptance remains separate.
