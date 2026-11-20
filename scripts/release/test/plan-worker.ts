import { DurableObject } from "cloudflare:workers";

// The classes a plan-check stack binds; Alchemy bundles this entry when it diffs the Worker.
export class PoolContainer extends DurableObject {}
export class PoolLedger extends DurableObject {}
export class PoolLedgerNext extends DurableObject {}
export class PoolRuntimeBlue extends DurableObject {}
export class ArtifactsTokenCoordinator extends DurableObject {}

export default { fetch: () => new Response("ok") };
