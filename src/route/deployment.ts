import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect } from "effect";
import { fileURLToPath } from "node:url";
import { euPlacement } from "../pool/placement.ts";

/** The route gateway image: the only thing Signalbox puts on a person's tailnet. */
export const routeGatewayImageContext = fileURLToPath(
  new URL("../../containers/route-gateway/", import.meta.url),
);

/**
 * "absent" keeps RouteGateway out of PoolWorker, so shipping this code creates no class. Declaring
 * it is the one irreversible step: a release whose class policy admits it does that. After that,
 * never go back to "absent". The plan would carry `deleted_classes` and destroy every route's
 * identity, and the plan check refuses it.
 */
export const routeGatewayClass = Config.Literals(
  ["declared", "absent"],
  "ROUTE_GATEWAY_CLASS",
).pipe(Config.withDefault("absent"));

const declareRouteGateway = (stage: string) =>
  Cloudflare.Container("RouteGateway", {
    name: `basalt-${stage}-route-gateway`,
    className: "RouteGateway",
    context: routeGatewayImageContext,
    instanceType: "lite",
    // One container per connected route account.
    maxInstances: 20,
    schedulingPolicy: "default",
    constraints: euPlacement,
    observability: { logs: { enabled: true } },
  });

export const routeGatewayBinding = Effect.gen(function* () {
  // Annotated so the absent case stays an absent key, which is what a Worker binding map accepts.
  const binding: { RouteGateway?: ReturnType<typeof declareRouteGateway> } = {};
  if ((yield* routeGatewayClass) === "declared")
    binding.RouteGateway = declareRouteGateway(yield* Stage);
  return binding;
});
