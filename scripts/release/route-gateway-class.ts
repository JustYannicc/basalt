/**
 * Whether a release declares the route gateway's Durable Object class (`ROUTE_GATEWAY_CLASS`, read
 * by `src/route/deployment.ts`).
 *
 * The class is declared once, by its own release under `policies/route-gateway-class.json`, and
 * from then on every release must keep it: an ordinary release that dropped it would plan the
 * binding's removal, which uploads `deleted_classes` and is refused. So the switch follows what
 * the stage records. It is declared exactly when the stage's State holds the class's container
 * application, which only the declare release creates. Before the declare, nothing is recorded and
 * an ordinary release plans no change for it.
 *
 * A policy's own value wins: the declare policy says `declared`; `absent` is an opt-out that only
 * a plan can show, because the plan check refuses the removal it would ask for.
 */
export type RouteGatewayClass = "declared" | "absent";

/** The class's container application in the release stack, which the declare release creates. */
export const routeGatewayFqn = "RouteGateway";

/**
 * Whether the stage already hosts the class: PoolWorker's State row (or the one it replaces)
 * records its namespace, or the class's application is recorded. Alchemy uploads PoolWorker with
 * the class before it creates the application, so either alone means the class exists, as
 * scripts/production.ts reads the fleet's.
 */
export const routeGatewayRecorded = (
  hostedClasses: readonly string[],
  applicationRecorded: boolean,
) => hostedClasses.includes(routeGatewayFqn) || applicationRecorded;

export function routeGatewayClassFor(
  policyValue: RouteGatewayClass | undefined,
  recorded: boolean,
): RouteGatewayClass {
  return policyValue ?? (recorded ? "declared" : "absent");
}
