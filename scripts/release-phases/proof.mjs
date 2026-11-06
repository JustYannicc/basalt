import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { selectResources } from "alchemy/ResourceSelection";
import { Effect, Exit, Redacted } from "effect";
import { databasePhaseResources } from "./deploy.ts";

/** Only provider side effects are simulated. Declarations, edges, selection and memoization are native. */
export const proveReleasePhases = (stack) =>
  Effect.gen(function* () {
    const declared = Object.values(stack.resources);
    const dependencies = (node) =>
      Object.keys(Output.upstreamAny([node.Props, stack.bindings[node.FQN] ?? []]));
    const selected = yield* selectResources(declared, dependencies, {
      include: databasePhaseResources,
    });
    const resources = declared.map((node) => ({
      id: node.FQN,
      type: node.Type,
      dependencies: dependencies(node),
    }));
    const runPhase = (failMigration) =>
      Effect.gen(function* () {
        const applied = [],
          failed = [];
        const pending = declared.filter((node) => selected.has(node.FQN));
        const outputs = {},
          props = {};
        const provider = yield* Command.Exec.Provider.pipe(
          Effect.provide(Command.ExecProvider()),
          Effect.provideService(Command.CommandExecutor, {
            spawn: () => Effect.die("Release proof cannot spawn a process"),
            run: (props) =>
              failMigration && props.command === "node src/migrate.ts"
                ? Effect.fail(new Error("53300"))
                : Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
          }),
        );
        while (pending.length) {
          const index = pending.findIndex((node) =>
            dependencies(node).every((id) => Object.hasOwn(outputs, id)),
          );
          if (index < 0) throw new Error("Release graph has unresolved dependencies");
          const [node] = pending.splice(index, 1);
          if (node.Type === "Command.Exec") {
            props[node.FQN] = yield* Output.evaluate(node.Props, outputs);
            const result = yield* Effect.exit(
              provider.reconcile({
                id: node.LogicalId,
                fqn: node.FQN,
                news: props[node.FQN],
                session: {},
              }),
            );
            if (Exit.isFailure(result)) {
              if (!failMigration || node.LogicalId !== "Migrations")
                return yield* Effect.failCause(result.cause);
              failed.push("Migrations:53300");
              break;
            }
            outputs[node.FQN] = result.value;
          } else {
            // Synthetic provider attributes are never connected to a database or sent to stdout.
            const origin = {
              host: "fixture.invalid",
              port: 5432,
              database: "postgres",
              user: "fixture",
              password: Redacted.make("fixture"),
            };
            outputs[node.FQN] = {
              id: node.FQN,
              name: "fixture",
              username: "fixture",
              origin,
              connectionUrl: Redacted.make("postgresql://fixture:fixture@fixture.invalid/postgres"),
            };
          }
          applied.push(node.FQN);
        }
        return { applied, failed, outputs, props, provider };
      });
    const failure = yield* runPhase(true);
    const success = yield* runPhase(false);
    const dbSecondPass = [],
      nextAttempt = [];
    for (const node of declared.filter(
      (node) => selected.has(node.FQN) && node.Type === "Command.Exec",
    )) {
      const news = yield* Output.evaluate(node.Props, success.outputs);
      const old = success.props[node.FQN];
      const diff = yield* success.provider.diff({
        olds: old,
        news,
        output: success.outputs[node.FQN],
      });
      dbSecondPass.push({ id: node.FQN, action: diff?.action ?? "unknown" });
      const changed = {
        ...news,
        env: { ...news.env, BASALT_RELEASE_ATTEMPT: "00000000-0000-4000-8000-000000000002" },
      };
      const retryDiff = yield* success.provider.diff({
        olds: old,
        news: changed,
        output: success.outputs[node.FQN],
      });
      nextAttempt.push({ id: node.FQN, action: retryDiff?.action ?? "unknown" });
    }
    return {
      resources,
      selected: [...selected].sort(),
      failed: failure.failed,
      applied: failure.applied,
      dbSecondPass,
      nextAttempt,
    };
  });
