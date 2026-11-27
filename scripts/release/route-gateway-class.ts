/**
 * Whether a release declares the route gateway's Durable Object class (`ROUTE_GATEWAY_CLASS`, read
 * by `src/route/deployment.ts`).
 *
 * The class is declared once, by its own release under `policies/route-gateway-class.json`, and
 * from then on every release must keep it: an ordinary release that dropped it would plan the
 * binding's removal, which uploads `deleted_classes` and is refused. So the switch follows what
 * the stage records. It is declared exactly when PoolWorker's State row records the class's
 * namespace, which only a declare's upload puts there. Before the declare, nothing is recorded and
 * an ordinary release plans no change for it.
 *
 * A policy's own value wins: the declare policy says `declared`; `absent` is an opt-out that only
 * a plan can show, because the plan check refuses the removal it would ask for.
 */
export type RouteGatewayClass = "declared" | "absent";

/** The class's container application in the release stack, which the declare release creates. */
export const routeGatewayFqn = "RouteGateway";
/** The Durable Object class itself, as PoolWorker's State row lists the classes it hosts. */
export const routeGatewayClassName = "RouteGateway";

/**
 * Whether the stage already hosts the class: PoolWorker's State row (or the one it replaces)
 * records its namespace, as scripts/production.ts reads the fleet's. The application's row is no
 * evidence: Alchemy records it when it publishes the image (precreate), before PoolWorker uploads
 * the class, so a declare that stopped in between has the row and no class.
 */
export const routeGatewayRecorded = (hostedClasses: readonly string[]) =>
  hostedClasses.includes(routeGatewayClassName);

export function routeGatewayClassFor(
  policyValue: RouteGatewayClass | undefined,
  recorded: boolean,
): RouteGatewayClass {
  return policyValue ?? (recorded ? "declared" : "absent");
}
