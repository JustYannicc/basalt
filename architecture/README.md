# Basalt architecture

This directory holds the hand-written model. It shows Basalt's modules, outside-service calls, current runtime, planned v1 modules, and workflows.

- `spec.c4` defines the model vocabulary and styles.
- `model/` defines Basalt and the relationships between its modules.
- `views/` contains sparse current and planned overviews plus v1 workflows.
- `gen/*.gen.c4` is generated from the stack declaration inventory and must not be edited by hand.
- `CONTEXT.md` is the machine-readable vocabulary used by architecture checks.

The router module maps to `src/router.ts` and its `brand.ts` configuration and declares `TOOLS_SERVICE=basalt.toolsGateway` and `POOL_SERVICE=basalt.modelGateway`. The tools gateway is one dependency boundary mapped to `.upstream/apps/hosted/cloud`; public identity, connectors, and vault interfaces are shown without expanding the dependency's internals. Its dynamic, per-person destinations use one `outsideServices` boundary reached through the tools gateway. Fixed infrastructure outside services must have separate adapter elements with host and SDK metadata from the stack inventory.

The resource inventory evaluates the actual root stack with synthetic required settings and the checked-in deployment choices. Network access is denied. Two explicit read fixtures provide a zone and an empty retirement-gate script list; any other request fails. The evaluator registers declarations without running provider lifecycle operations or provisioning commands. Exported stateful classes are inventoried with their owning worker and drawn inside it. The generated binding digest preserves known declaration names and kinds while deferred binding contributions stay unresolved. It does not inspect a live account. The source scanner covers Basalt-owned runtime code under `src/`, `packages/`, `containers/`, and declared runtime code paths. It excludes the pinned dependency's internals under `.upstream/` and maps that tree as one code boundary. Python source uses AST parsing without importing or executing inspected code. Container runtime ownership follows the final Docker stage; build-stage release acquisition participates in the deployment fingerprint. Unsupported context selection and unresolved runtime destinations fail. The dependency's internal host and import inventory is outside the owned-source check.

The current router sends `/v1` and its descendants, plus `/v0/management` and `/v8/management`, through `POOL_SERVICE` to the model gateway. Other requests use the tools service binding. The gateway uses one EU control-plane actor and one warm EU container running the released control-plane and inference binaries under a Python supervisor. Container placement uses the default scheduling policy with EU jurisdiction and east/west EU region constraints. The pool database is separate within the existing EU cluster and uses a direct connection with verified TLS.

The disabled app-hosting origin in the router configuration is represented as a planned outside boundary. Pool app ownership, sharing, setup and usage integration remain planned. Current public identity, connector and vault behavior belongs to the pinned tools dependency. The Basalt-facing identity, connection and vault interfaces remain planned integrations. Workflow descriptions distinguish those targets from the running transport.

Every PR that changes modules, outside services, deployment or flows updates this directory in the same PR. Keep module interfaces and outside services in the authored model; regenerate deployment files instead of editing them.

Install the check tooling with `bun install --cwd scripts/architecture --frozen-lockfile`. Prepare the pinned dependency with `bun run prepare:upstream` before inspecting the stack, then run `bun run --cwd .upstream/apps/hosted/cloud framework:build` to prepare its framework reference. Then run:

```sh
bun run architecture:format
bun run architecture:validate
bun run architecture:model
bun run architecture:typecheck
bun run architecture:inventory
bun run architecture:deployment
bun run architecture:validate
bun run architecture:test
```

CI runs format and validation first, then generated element types and typechecking, then deployment regeneration with a clean-diff check and validation, then the fitness tests. Validation includes layout drift. The deploy workflow also regenerates element types before its existing typecheck.

Each owned module has `metadata { code '<relative path>' }`. `bindings` maps source service bindings to model element IDs. `resources` lists the stable resource IDs printed by the inventory command, separated by `|`; each resource maps to exactly one logical element. The generator creates a deployment instance for each resource and stores its ID in instance metadata. IDs are `resource-` followed by the lowercase SHA-256 of the full resource type, a NUL separator, and its fully qualified name. Missing, stale and duplicate mappings fail generation. The generated deployment also fingerprints the local stack source graph, container context inputs, public asset bytes, dependency pin and patches, so changes to settings or bindings require regeneration even when resource IDs stay the same.

Code naming model elements imports `$ElementId` from the generated module under `scripts/architecture/gen/`. That module is rebuilt in CI and ignored by Git. Renaming an element without updating its code references fails typechecking. The source check requires an explicit relationship for cross-module imports and service bindings, and an external element plus caller relationship for concrete outside hosts and SDKs. Unresolved computed fetch destinations fail instead of being assumed safe.

Dynamic-view steps are checked against model relationships. Real trace comparison and live provider-state comparison are outside this check.
