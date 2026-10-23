# CLIProxyAPI pool container

This image runs one Home control plane and one CLIProxyAPI node in one container. Deploy it as a Cloudflare Container with jurisdiction <code>eu</code>, regions <code>EEUR/WEUR</code>, and the default placement policy. The parent app owns that placement and keeps the container warm. Snapshot placement is out of scope.

The only upstream artifact pins and SHA-256 values live in releases.json. The build downloads the upstream Linux no-plugin release assets and verifies each digest before extracting the two binaries. These assets support Alpine/musl and do not load dynamic plugins.

## Build context

The Docker build context is this directory:

<pre><code>docker build -t basalt-pool:local containers/pool</code></pre>

## Runtime contract

Required environment:

- <code>POOL_DATABASE_URL</code>: direct PostgreSQL URI for Home's dedicated logical database. The URI is written unchanged into a YAML scalar under /dev/shm; reserved URI characters must already be percent-encoded. Query options such as <code>options=-c%20role%3Dbasalt_pool_owner</code> are preserved.
- <code>POOL_MANAGEMENT_KEY</code>: Home management key. The supervisor maps it to Home's <code>MANAGEMENT_PASSWORD</code> environment override and uses it for local Management API calls and readiness authentication.

Optional environment:

- <code>POOL_MANAGEMENT_ALLOW_REMOTE</code>: defaults to <code>false</code>. The parent app sets <code>true</code> when exposing Home management through its private service binding. Home still requires the management key.

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

The normal <code>GET /v1/models</code> contract does not expose a universal speed-tier matrix. CPA also supports <code>GET /v1/models?client_version=cpa</code> for its richer Codex-client catalog. In the pinned source, template service tiers are retained for pure Codex-provider models and cleared for non-Codex or mixed-provider models. This does not establish complete Claude Fast coverage; that catalog path still needs review. Keep ordinary clients on the default <code>/v1/models</code> response unless they explicitly consume the CPA-specific schema.

The bootstrap unit tests use only Python's standard library and can be run from the repository root with <code>python3 -m unittest containers.pool.test_bootstrap</code>. The parent owns the Docker/PostgreSQL integration run.

## Compatibility caveat

The selected Home release declares a CLIProxyAPI module dependency older than the separately pinned node release. Upstream publishes no compatibility matrix for this pair. The local Docker/PostgreSQL integration exercises bootstrap, a synthetic provider stream, affinity, spreading, quota failover and restart persistence with this pair. Real-subscription acceptance remains separate.
