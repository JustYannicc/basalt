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
| Identity interface | Basalt's planned interface; the dependency already provides public identity behavior. |
| Model gateway | Basalt's planned single entry point for model requests. |
| Tools gateway | The current public dependency boundary for identity, connectors, vault, and tools. |
| Pool | A set of model accounts served through the model gateway. |
| Pool runtime | The planned singleton EU actor and its warm container process. |
| Pool database | A separate logical pool database in the same EU cluster. |
| Connection interface | Basalt's planned interface; the dependency already provides public connectors. |
| Vault interface | Basalt's planned interface; the dependency already provides public secret custody. |
| Organization | A sharing boundary in the dependency; not a Basalt module or element kind. |
| Outside services | Dynamic per-person destinations, reached only through the tools gateway. |
| Fixed infrastructure adapter | A distinct adapter for each fixed outside service found in the stack declaration inventory. |

The current router returns HTTP 503 for `/v1` and `/v1/*`. Non-`/v1` requests pass through `TOOLS_SERVICE` to the tools gateway. Only Basalt-facing model, pool, identity, connection, and vault interfaces are planned; the dependency's public behavior remains current.

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
| Model provider | An outside service serving inference behind a pool. |
| Outside service | A service reached through a gateway or an infrastructure adapter. |

Infrastructure adapters carry provider names only in `technology`. Their resource mappings cover declarations evaluated for the checked-in deployment choices. They do not assert that the resources exist in the production account.
