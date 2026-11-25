import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer } from "effect";
import { fileURLToPath } from "node:url";
import { euPlacement } from "../../src/pool/placement.ts";
import { gatewayName, stages, workerName, type Stage as ScratchStage } from "./settings.ts";

const standin = fileURLToPath(new URL("./standin/", import.meta.url));

// This stack owns no DNS, production bindings, retained databases or shared app resources. Its
// state is local to the runner, and everything it names carries the stage's own prefix.
export default Alchemy.Stack(
  "basalt-route-scratch",
  { providers: Layer.mergeAll(Cloudflare.providers()), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = (yield* Stage) as ScratchStage;
    if (!stages.includes(stage))
      return yield* Effect.die(new Error("Only the route scratch stages are allowed"));
    if (stage === "test-route-scratch-2")
      // TODO(integrator, s1380): the exit-node run. The control server joins this stage and the
      // exit node runs outside Cloudflare; the route gateway uses P1's image
      // (containers/route-gateway/) instead of the stand-in. Until then this stage deploys nothing.
      return yield* Effect.die(new Error("test-route-scratch-2 is not built yet"));
    const gateway = Cloudflare.Container("RouteGateway", {
      name: gatewayName(stage),
      className: "RouteGateway",
      // The stand-in never dials out: its only CONNECT target is an echo it serves itself.
      context: standin,
      instanceType: "lite",
      maxInstances: 1,
      schedulingPolicy: "default",
      constraints: euPlacement,
      observability: { logs: { enabled: true } },
    });
    return yield* Cloudflare.Worker("Pool", {
      name: workerName(stage),
      main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
      workersDev: true,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: {
        RouteGateway: gateway,
        PoolContainer: Cloudflare.DurableObject("ScratchController"),
        // Made fresh in the job for this run and never stored anywhere else.
        POOL_APP_SIGNING_KEY: yield* Config.Redacted("ROUTE_SCRATCH_SIGNING_KEY"),
      },
    });
  }),
);
