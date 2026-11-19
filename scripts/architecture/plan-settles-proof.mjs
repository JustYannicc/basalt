import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";

/** What each provider keeps readable while its resource updates, as the installed providers declare. */
const stables = {
  "Cloudflare.Worker": ["workerId", "workerName"],
  "Cloudflare.Hyperdrive": ["hyperdriveId", "accountId"],
  "Cloudflare.Container": ["accountId", "applicationId"],
};
/** These read deployed state, which the first deploy of an empty state does not have yet. */
const afterFirstDeploy = ["ToolsBackendBudget"];

/**
 * Real declarations, bindings, Plan, Apply and the native command provider with its memoisation.
 * Only provider effects are synthetic, and every other provider uses the engine's default diff: a
 * row is an update exactly when its resolved inputs differ or hold a value unknown at plan time.
 */
export const provePlanSettles = (stack, recompile) =>
  Effect.gen(function* () {
    let phase = "providers";
    const whole = (source) => ({ ...source, actions: {}, output: {} });
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
      accountId: "0".repeat(32),
      origin,
      pooledOrigin: origin,
      connectionUrl: Redacted.make("postgresql://fixture:fixture@fixture.invalid/postgres"),
      text: "fixture",
      enabled: true,
      mtlsCertificateId: "fixture",
      workerId: fqn,
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
    const layers = [...new Set(Object.values(stack.resources).map((node) => node.Type))]
      .filter((type) => type !== "Command.Exec")
      .map((type) =>
        Provider.succeed(Resource(type), {
          ...(stables[type] ? { stables: stables[type] } : {}),
          // The pool Worker and its container name each other; the engine breaks such a cycle by
          // creating one side early, as the installed Worker provider allows.
          ...(type === "Cloudflare.Worker"
            ? { precreate: ({ fqn }) => Effect.sync(() => attributes(type, fqn)) }
            : {}),
          reconcile: ({ fqn }) => Effect.sync(() => attributes(type, fqn)),
          delete: () => Effect.void,
        }),
      );
    layers.push(
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
    const run = (program, source) =>
      program.pipe(
        Effect.provideService(State, memory),
        Effect.provide(providers),
        Effect.provideContext(source.services),
      );
    const rows = (source) => (plan) => {
      const inputs = (node) =>
        Object.keys(Output.upstreamAny([node.Props, source.bindings[node.FQN] ?? []]));
      return Object.values(plan.resources)
        .filter((node) => node.action !== "noop")
        .map((node) => ({
          id: node.resource.FQN,
          type: node.resource.Type,
          action: node.action,
          // A command may run on every plan only while no resource waits on its outcome.
          readers: Object.values(source.resources)
            .filter(
              (other) =>
                !other.Type.startsWith("Command.") && inputs(other).includes(node.resource.FQN),
            )
            .map((other) => other.FQN)
            .sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    };
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        phase = "first-deploy";
        const first = {
          ...whole(stack),
          resources: Object.fromEntries(
            Object.entries(stack.resources).filter(([id]) => !afterFirstDeploy.includes(id)),
          ),
        };
        yield* run(Effect.flatMap(Plan.make(first), Apply.apply), stack);
        phase = "second-deploy";
        yield* run(Effect.flatMap(Plan.make(whole(stack)), Apply.apply), stack);
        phase = "plan";
        const afterApply = rows(stack)(yield* run(Plan.make(whole(stack)), stack));
        phase = "next-attempt-plan";
        const nextAttempt = yield* recompile((next) =>
          run(Plan.make(whole(next)), next).pipe(Effect.map(rows(next))),
        );
        return { resources: Object.keys(stack.resources).length, afterApply, nextAttempt };
      }),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    // Messages and causes can hold paths and settings; only the phase and the error's class leave.
    const error = /^[A-Za-z]{1,60}/.exec(Cause.pretty(exit.cause))?.[0] ?? "unknown";
    return { failed: phase, error };
  }).pipe(Effect.provideContext(stack.services));
