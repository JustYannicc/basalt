import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect } from "effect";
import { fileURLToPath } from "node:url";
import { euPlacement } from "../../src/pool/placement.ts";
import { container, instanceType, prefix, stage, worker } from "./settings.ts";

// This stack owns one keyed mock and its Worker: no DNS, databases, production bindings or state store.
export default Alchemy.Stack(
  prefix,
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    if ((yield* Stage) !== stage) return yield* Effect.die(new Error(`Only ${stage} is allowed`));
    const mock = Cloudflare.Container("Mock", {
      name: container,
      className: "Mock",
      context: fileURLToPath(new URL("../../containers/emulated-upstream/", import.meta.url)),
      schedulingPolicy: "default",
      instanceType,
      maxInstances: 1,
      constraints: euPlacement,
      observability: { logs: { enabled: true } },
    });
    return yield* Cloudflare.Worker("Gateway", {
      name: worker,
      main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
      workersDev: true,
      compatibility: { date: "2026-09-08" },
      env: {
        Mock: mock,
        MOCK_KEY: yield* Config.Redacted("EMULATED_UPSTREAM_KEY"),
        // The lease: epoch milliseconds after which check refuses and the hourly expiry destroys.
        DELETE_BY: yield* Config.String("EMULATED_DELETE_BY"),
      },
    });
  }),
);
