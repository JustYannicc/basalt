import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { CloudflareLogs } from "../../node_modules/alchemy/src/Cloudflare/Logs.ts";
import { WorkerBundle } from "../../node_modules/alchemy/src/Cloudflare/Workers/Sources/Rolldown.ts";
import { Worker } from "../../node_modules/alchemy/src/Cloudflare/Workers/Worker.ts";
import { LiveWorkerProvider } from "../../node_modules/alchemy/src/Cloudflare/Workers/WorkerProvider.ts";

const accountId = "0".repeat(32);
const poolWorker = "PoolWorker";
/** This reads deployed state, which the first deploy of an empty state does not have yet. */
const afterFirstDeploy = ["ToolsBackendBudget"];

/**
 * Real declarations, bindings, Plan and Apply, and the installed Worker provider's own answer for
 * the pool Worker. Provider effects are synthetic. A Worker records a namespace for every Durable
 * Object binding it has, as the platform returns one for a class another Worker hosts too.
 */
export const proveRootContainerPlan = (stack) =>
  Effect.gen(function* () {
    let phase = "providers";
    const whole = { ...stack, actions: {}, output: {} };
    const origin = {
      host: "fixture.invalid",
      port: 6432,
      database: "postgres",
      user: "fixture",
      password: Redacted.make("fixture"),
    };
    // One bag serves every provider: a declaration reads only the attributes its upstream has.
    const attributes = (type, fqn) => ({
      id: fqn,
      name: "fixture",
      username: "fixture",
      accountId,
      origin,
      pooledOrigin: origin,
      connectionUrl: Redacted.make("postgresql://fixture:fixture@fixture.invalid/postgres"),
      text: Redacted.make("fixture"),
      enabled: true,
      mtlsCertificateId: "fixture",
      workerId: "f".repeat(32),
      workerName: `fixture-${fqn.toLowerCase()}`,
      url: "https://fixture.invalid",
      hyperdriveId: "fixture",
      applicationId: "fixture",
      applicationName: "fixture",
      configuration: { image: "fixture" },
      outdir: "fixture",
      hash:
        type === "Cloudflare.Container"
          ? { image: "0123456789abcdef", digest: `sha256:${"0".repeat(64)}` }
          : type === "Command.Build"
            ? { input: "fixture", output: "fixture" }
            : "fixture",
    });
    const classBindings = (bindings) =>
      (Array.isArray(bindings) ? bindings : [])
        .flatMap((binding) => binding.data?.bindings ?? [])
        .filter((binding) => binding.type === "durable_object_namespace" && binding.className);
    const worker = (fqn, bindings) => ({
      ...attributes("Cloudflare.Worker", fqn),
      crons: [],
      routes: [],
      urls: [],
      durableObjectNamespaces: Object.fromEntries(
        classBindings(bindings).map(({ className }) => [className, `namespace-${className}`]),
      ),
    });
    const installed = (effect) =>
      effect.pipe(
        Effect.provideService(WorkerBundle, {}),
        Effect.provideService(CloudflareLogs, {}),
        Effect.provideService(Stack, stack),
        Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
        Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId })),
        Effect.provide(NodeServices.layer),
      );
    const installedWorker = yield* installed(
      Worker.Provider.pipe(Effect.provide(LiveWorkerProvider())),
    );
    // The planner asks more than once: with the Worker's bindings resolved, and unresolved while
    // it follows the cycle with the container. Every answer counts.
    const observed = { hosted: [], recorded: [], readable: [], unresolved: [] };
    const layers = [...new Set(Object.values(stack.resources).map((node) => node.Type))]
      .filter((type) => type !== "Command.Exec" && type !== "Cloudflare.Worker")
      .map((type) =>
        Provider.succeed(Resource(type), {
          ...(type === "Cloudflare.Hyperdrive" ? { stables: ["hyperdriveId", "accountId"] } : {}),
          ...(type === "Cloudflare.Container" ? { stables: ["accountId", "applicationId"] } : {}),
          reconcile: ({ fqn }) => Effect.sync(() => attributes(type, fqn)),
          delete: () => Effect.void,
        }),
      );
    layers.push(
      Provider.succeed(Resource("Cloudflare.Worker"), {
        stables: ["workerId", "workerName"],
        // The pool Worker and its container name each other; the engine breaks such a cycle by
        // creating one side early, as the installed Worker provider allows.
        precreate: ({ fqn }) => Effect.sync(() => worker(fqn, [])),
        diff: (input) =>
          input.fqn !== poolWorker
            ? Effect.succeed(undefined)
            : installed(installedWorker.diff(input)).pipe(
                Effect.tap((diff) =>
                  Effect.sync(() => {
                    observed.readable.push(
                      diff?.stables?.includes("durableObjectNamespaces") ?? false,
                    );
                    observed.unresolved.push(
                      classBindings(input.newBindings).some(
                        ({ scriptName }) =>
                          scriptName !== undefined && typeof scriptName !== "string",
                      ),
                    );
                  }),
                ),
              ),
        reconcile: ({ fqn, bindings }) =>
          Effect.sync(() => {
            if (fqn === poolWorker) {
              const classes = classBindings(bindings);
              observed.recorded = classes.map(({ className }) => className).sort();
              observed.hosted = classes
                .filter(({ scriptName }) => scriptName === undefined)
                .map(({ className }) => className)
                .sort();
            }
            return worker(fqn, bindings);
          }),
        delete: () => Effect.void,
      }),
      Command.ExecProvider().pipe(
        Layer.provide(
          Layer.succeed(Command.CommandExecutor, {
            spawn: () => Effect.die("Plan proof cannot spawn processes"),
            run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
          }),
        ),
      ),
    );
    const providers = Layer.mergeAll(...layers);
    const memory = InMemoryService();
    const run = (program) =>
      program.pipe(
        Effect.provideService(State, memory),
        Effect.provide(providers),
        Effect.provideContext(stack.services),
      );
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        phase = "first-deploy";
        const first = {
          ...whole,
          resources: Object.fromEntries(
            Object.entries(stack.resources).filter(([id]) => !afterFirstDeploy.includes(id)),
          ),
        };
        yield* run(Effect.flatMap(Plan.make(first), Apply.apply));
        phase = "second-deploy";
        yield* run(Effect.flatMap(Plan.make(whole), Apply.apply));
        phase = "plan";
        const plan = yield* run(Plan.make(whole));
        return {
          resources: Object.keys(stack.resources).length,
          ...observed,
          afterApply: Object.values(plan.resources)
            .filter((node) => node.action !== "noop")
            .map((node) => ({
              id: node.resource.FQN,
              type: node.resource.Type,
              action: node.action,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      }),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    // Messages and causes can hold paths and settings; only the phase and the error's class leave.
    const error = /^[A-Za-z]{1,60}/.exec(Cause.pretty(exit.cause))?.[0] ?? "unknown";
    return { failed: phase, error };
  }).pipe(Effect.provideContext(stack.services));
