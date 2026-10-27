# Basalt architecture context

The model uses the names and identifiers below. Planned parts are not current deployment resources.

## Element kinds

| Identifier | Meaning |
| --- | --- |
| `system` | Component boundary. |
| `person` | Human user or owner. |
| `client` | Client process outside the component boundary. |
| `door` | Stateless transport boundary. |
| `actor` | Stateful runtime actor. |
| `module` | Deep module with a small interface. |
| `adapter` | Replaceable implementation at a seam. |
| `iface` | Module interface. |
| `part` | Hidden implementation part or seam. |
| `store` | Store or projection. |
| `external` | Service outside the component boundary. |
| `toplevel` | A person's root level. |
| `folder` | A nested place for work. |
| `thread` | A durable unit of work. |
| `app` | Server and UI placed in a folder. |
| `state` | Persisted state. |
| `entity` | Domain record. |

## Deployment kinds

| Identifier | Meaning |
| --- | --- |
| `stage` | Deployment stage. |
| `zone` | Provider or network boundary. |
| `worker` | Deployed request process. |
| `durableObject` | Stateful actor class. |
| `isolate` | Isolated process. |
| `container` | Container process. |
| `workflow` | Workflow engine. |
| `queue` | Message queue. |
| `storage` | Object or database storage. |
| `vm` | Machine. |
| `device` | Person's device. |

## Tags

| Identifier | Meaning |
| --- | --- |
| `v1` | First release scope. |
| `deep` | Deep module boundary. |
| `shallow` | Boundary with little hidden implementation. |
| `passthrough` | Boundary that primarily forwards a request. |
| `hypothetical-seam` | Possible seam without a second implementation. |
| `planned` | Target not implemented in the current stack. |
| `decided` | Recorded decision. |
| `assumption` | Working assumption. |
| `smell` | Boundary or dependency needing review. |
| `port` | Module's front door. |
| `publishable` | Module intended to stand on its own. |
| `funnel` | Single gateway for a capability crossing. |
| `basalt` | Element owned by this component. |
| `external` | Service outside the component boundary. |

## Relationship kinds

| Identifier | Meaning |
| --- | --- |
| `sync` | Synchronous call. |
| `async` | Asynchronous delivery. |
| `model` | Model request or response. |
| `tool` | Tool call or outside service call. |
| `reach` | Placement reaches a location. |
| `lend` | Explicit, revocable loan. |
| `mount` | Mount across an ownership boundary. |
| `transition` | State transition. |
| `owns` | Ownership relationship. |

## Gateway terms

| Term | Meaning |
| --- | --- |
| `client gateway` | The one typed entry point for every client into the modules. |
| `model gateway` | The one entry point for every model request. A pool answers behind it. |
| `tools gateway` | The one entry point for every tool call and outside-service call. |

## Component terms

| Term | Meaning |
| --- | --- |
| Build | The owned programs that prepare source, verify downloads and bundle the product. |
| Deployment | The owned orchestration and provisioning programs that publish and check the product. |
| Brand configuration | Shared literal data read by runtime, build and deployment programs. |
| Provider source | The outside service supplying pinned Home source for provider catalog checks. |
| Release source | The outside service that supplies verified release archives during the image build. |
| Update source | The outside source of release metadata, patch merge ancestry, pull requests and exact-head workflow evidence. |
| Release updates | Proposes pinned versions, verifies disposable previews, and checks current green proofs before an expected-head squash merge. V1 accepts a main advance after the final check; deployment waits for successful CI on the exact merged main commit. |
| Deployment provider | The outside control-plane API used to provision hosting resources. |
| Identity interface | Basalt's planned interface; the dependency already provides public identity behavior. |
| Model gateway | The current entry point for model requests, signed pool control calls and private signed setup actions. It owns computer registration and encrypted one-time credentials through the pool controller. |
| Feedback | A report a person chooses to send about a product experience. |
| Telemetry | Product events, errors and traces produced by Basalt for analysis and diagnosis. |
| Tools gateway | The current public dependency boundary for identity, connectors, vault, and tools. |
| Pool app | One private app instance per person per organization, run by the tools service. Its accounts are scoped to a channel group in the shared runtime. It requests a signed setup intent and opens the root setup page. |
| Setup host | The root setup React screen and HTTP handlers. It reuses pool UI components, verifies native cookie sessions and manages personal PATs through the tools gateway; private pool actions have an action-bound signature and 30-second expiry. |
| Config installer | The Node.js program that consumes a setup link, parses and writes backed-up marked client config, and supports undo. |
| Setup intent | A signed user-and-pool context requested by the pool app; valid for five minutes and checked against the native session user. |
| Personal PAT | A personal tools API token created and deleted through native cookie-authenticated auth endpoints. |
| One-time credentials | The model key and personal PAT, encrypted in the pool controller and durably consumed before the setup response; claim expiry is five minutes. |
| Computer observation | Successful model usage for the exact key and current pool binding, plus a real successful MCP tool call recorded through a private signed action. Both are required for green status. |
| Pool controller | The singleton EU control-plane actor that owns readiness, warmth and recovery alarms. |
| Pool runtime | The warm EU container running the released control-plane and inference binaries. |
| Pool database | A separate logical pool database in the same EU cluster. |
| Connection interface | Basalt's planned interface; the dependency already provides public connectors. |
| Vault interface | Basalt's planned interface; the dependency already provides public secret custody. |
| Organization | A sharing boundary in the dependency; not a Basalt module or element kind. |
| Connector catalog | Read-only Worker serving the official app feed plus operator notices and published additions. Its configuration and feed data are outside the tools API Worker. |
| Outside services | Dynamic per-person destinations, reached only through the tools gateway. |
| Fixed infrastructure adapter | A distinct adapter for each fixed outside service found in the stack declaration inventory. |

`AccountConnected` and `app_installed` name separate product events; one does not imply the other.

The catalog's carried apps pin the exact prepared host framework and default-export `defineApp` from their root entrypoint. Read operations explicitly run without approval; ticket creation always requires approval. The ticket app takes a validated site through native account connection setup. The saved account binds authorization, callback, refresh, API and health to that exact site. Catalog requests and tool input cannot select the tenant. Its source stays available independently of optional hosted credentials. Community publication uses a separately validated public framework release and an approved publisher namespace.

The current router sends `/v1` and `/pool/v1/*` through `POOL_SERVICE` to the model gateway. The pool app calls the public control API with a per-pool signed token and the tools caller identity. The controller scopes accounts to the pool's channel group; changes are owner-only. Public `/v0/management` and `/v8/management` paths return 404; management port 8327 stays internal to the controller. Dashboard, MCP and OAuth requests use `TOOLS_SERVICE`, while entry redirects and brand pages stay in the router. The model gateway, pool controller, pool runtime and pool database are implemented. The pool app's ownership checks and Accounts screen are implemented in source. The tools service installs and upgrades one private pool app per verified person per organization, links its signed token and runs its tools with the caller. Sharing uses the tools service's built-in sharing. Computer setup (#1411) is implemented in source through a root `/setup` page served as router static assets and same-origin HTTP handlers. Live setup acceptance is pending. App hosting, model requests through the app and the Basalt-facing identity, connection and vault interfaces remain planned.

The `hosts` and `sdks` values `dynamic` and `upstream` describe the opaque, dynamically selected outside-service boundary. They do not enumerate concrete hosts or packages. Fixed infrastructure hosts and SDKs belong on their own adapter elements. Multiple values use `|` separators.

## Adapter terms

| Term | Meaning |
| --- | --- |
| Client gateway | The one typed entry point for clients into modules; it belongs to the composing application. |
| Identity provider | The service that signs people in and holds organizations. |
| Runtime adapter | The hosting implementation behind a module. |
| Database adapter | The implementation used to read and write persistent records. |
| Observability adapter | The implementation that records diagnostics and operational events. |
| Record storage | The full durable record from which a working copy can be rebuilt. |
| Model provider | An outside service serving inference behind a pool; owners sign in on its page in their own browser. |
| Outside service | A service reached through a gateway or an infrastructure adapter. |

Infrastructure adapters carry provider names only in `technology`. Their resource mappings cover declarations evaluated for the checked-in deployment choices. They do not assert that the resources exist in the production account.


The connector catalog is served under `/catalog/` through its own service binding. The tools gateway reads that feed and uses hosted connector OAuth clients. Sign-in clients are separate. Official app documents pass through except for the pinned messaging package, which carries a contributed user-only OAuth method selected first in the feed. Its hosted client requests user scopes and stores the nested personal grant. Missing client credentials leave a setup notice. The data-access connector is in External Testing, separate from identity sign-in. Its notice explains listed test-user access and seven-day authorization and refresh-token expiry, including for its all-in-one app. Source checks do not establish live connection or client acceptance.

The catalog also carries a private read-only knowledge and issue app. Its provenance records a public fork revision and source hashes. A captured public source baseline retains its exact public framework pin. A manifest-only patch makes the served app match the Basalt host release; its five reads explicitly require no approval. The runtime proof checks that pin through the host release API before deployment. Community publication needs an approved publisher scope and proof against the chosen public host. The hosted-client definition remains a separate deployment-owned runtime patch; the generic operator-configuration proposal is upstream issue #2382. Each caller links a personal account for both APIs. Its OAuth identity and API endpoints have separate outside adapters; managed access tokens go only to the API host. Missing hosted client credentials leave the app listed with a setup notice. App source remains in the catalog Worker. Live consent and client acceptance remain pending.

## App outbound requests

The private app outbound Worker supplies `User-Agent: Executor` when an app
request has no User-Agent header. Some outside services require this header before they check
authentication. Explicit app headers and request bodies pass through unchanged.
