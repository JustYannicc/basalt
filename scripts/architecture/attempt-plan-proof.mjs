import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";

/**
 * Real declarations, Plan, Apply and the native command provider with its memoisation. Only
 * provider effects are synthetic, and every other provider uses the engine's default diff: a row
 * is an update exactly when its resolved props differ or hold a value unknown at plan time.
 * Dependencies carried by props are planned; binding payloads are left out, as in the connection
 * proofs.
 */
export const proveAttemptPlan = (stack, recompile) =>
  Effect.gen(function* () {
    let phase = "providers";
    const isolate = (source) => ({ ...source, bindings: {}, actions: {}, output: {} });
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
          reconcile: ({ fqn }) => Effect.sync(() => attributes(type, fqn)),
          delete: () => Effect.void,
        }),
      );
    layers.push(
      Command.ExecProvider().pipe(
        Layer.provide(
          Layer.succeed(Command.CommandExecutor, {
            spawn: () => Effect.die("Attempt plan proof cannot spawn processes"),
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
    const rows = (plan) =>
      Object.values(plan.resources)
        .filter((node) => node.action !== "noop")
        .map((node) => ({ id: node.resource.FQN, type: node.resource.Type, action: node.action }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        phase = "first-plan";
        const first = yield* run(Plan.make(isolate(stack)), stack);
        phase = "apply";
        yield* run(Apply.apply(first), stack);
        phase = "second-plan";
        const secondPlan = rows(yield* run(Plan.make(isolate(stack)), stack));
        phase = "next-attempt-plan";
        const nextAttempt = yield* recompile((next) =>
          run(Plan.make(isolate(next)), next).pipe(Effect.map(rows)),
        );
        return { resources: Object.keys(stack.resources).length, secondPlan, nextAttempt };
      }),
    );
    // The harness never forwards messages or causes; the phase names where to look.
    return Exit.isSuccess(exit)
      ? exit.value
      : { failed: phase, detail: Cause.pretty(exit.cause).slice(0, 700) };
  }).pipe(Effect.provideContext(stack.services));
