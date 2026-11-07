import assert from "node:assert/strict";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { selectResources } from "alchemy/ResourceSelection";
import { isResolved } from "alchemy/Diff";
import { Effect, Layer, Redacted } from "effect";
import { assertSupportedPlan } from "./alchemy-plan.ts";
import { BarrierRefusal } from "./manifest.ts";
import { databasePhaseResources } from "../release-phases/deploy.ts";

/** Real declarations, Plan, Apply and provider diffs; only effects and stored state are synthetic. */
export const proveConnectionPlan = (
  stack,
  recompile,
  change,
  connectionId = "DatabaseConnection",
) =>
  Effect.gen(function* () {
    const dependencies = (node, source = stack) =>
      Object.keys(Output.upstreamAny([node.Props, source.bindings[node.FQN] ?? []]));
    const selected = new Set();
    const include = (id) => {
      if (selected.has(id)) return;
      selected.add(id);
      const resource = stack.resources[id];
      assert.ok(resource);
      for (const dependency of dependencies(resource)) include(dependency);
    };
    for (const id of [connectionId, "Migrations", "RuntimeDatabaseBudget", "PoolDatabase"])
      include(id);
    const isolate = (source) => ({
      ...source,
      resources: Object.fromEntries([...selected].map((id) => [id, source.resources[id]])),
      bindings: {},
      actions: {},
      output: {},
    });
    const actual = yield* Provider.findProviderByType(stack.resources[connectionId].Type);
    const origin = {
      host: "fixture.invalid",
      port: 6432,
      database: "postgres",
      user: "fixture",
      password: Redacted.make("fixture"),
    };
    const attributes = {
      id: "fixture",
      name: "fixture",
      accountId: "0".repeat(32),
      origin,
      pooledOrigin: origin,
      text: "fixture",
      mtlsCertificateId: "fixture",
    };
    let connectionWrites = 0;
    let commandRuns = 0;
    const layers = [...new Set([...selected].map((id) => stack.resources[id].Type))]
      .filter((type) => type !== "Command.Exec")
      .map((type) =>
        Provider.succeed(Resource(type), {
          ...(type === stack.resources[connectionId].Type
            ? { diff: actual.diff, stables: actual.stables }
            : {}),
          reconcile: () =>
            Effect.sync(() => {
              if (type === stack.resources[connectionId].Type) connectionWrites++;
              return attributes;
            }),
          delete: () => Effect.void,
        }),
      );
    layers.push(
      Command.ExecProvider().pipe(
        Layer.provide(
          Layer.succeed(Command.CommandExecutor, {
            spawn: () => Effect.die("Connection proof cannot spawn processes"),
            run: () =>
              Effect.sync(() => {
                commandRuns++;
                return { exitCode: 0, stdout: "", stderr: "" };
              }),
          }),
        ),
      ),
    );
    const providers = Layer.mergeAll(...layers);
    const memory = InMemoryService();
    const store = yield* memory;
    const read = () => store.get({ stack: stack.name, stage: stack.stage, fqn: connectionId });
    const run = (program, source) =>
      program.pipe(
        Effect.provideService(State, memory),
        Effect.provide(providers),
        Effect.provideContext(source.services),
      );
    yield* run(
      Effect.gen(function* () {
        yield* Apply.apply(yield* Plan.make(isolate(stack)));
      }),
      stack,
    );
    const before = yield* read();
    connectionWrites = 0;
    commandRuns = 0;
    return yield* recompile((next) =>
      run(
        Effect.gen(function* () {
          const connection = next.resources[connectionId];
          if (change === "name")
            connection.Props = { ...connection.Props, name: "fixture-replacement" };
          if (change === "origin")
            connection.Props = {
              ...connection.Props,
              origin: connection.Props.origin.pipe(
                Output.map((value) => ({ ...value, port: value.port + 1 })),
              ),
            };
          if (change === "limit")
            connection.Props = {
              ...connection.Props,
              originConnectionLimit: (connection.Props.originConnectionLimit ?? 0) + 1,
            };
          if (change === "tls")
            connection.Props = {
              ...connection.Props,
              mtls: { ...connection.Props.mtls, sslmode: "require" },
            };
          const plan = yield* Plan.make(isolate(next));
          const node = plan.resources[connectionId];
          let refusal = null;
          try {
            assertSupportedPlan(plan);
          } catch (error) {
            if (!(error instanceof BarrierRefusal)) throw error;
            refusal = error.reason;
          }
          const databasePhase = yield* selectResources(
            Object.values(next.resources),
            (node) => dependencies(node, next),
            { include: databasePhaseResources },
          );
          const result = {
            action: node.action,
            connectionIds: Object.values(next.resources)
              .filter((resource) => resource.Type === connection.Type)
              .map((resource) => resource.FQN)
              .sort(),
            poolWorkerDependencies: dependencies(next.resources.PoolWorker, next).sort(),
            poolAction: plan.resources.PoolDatabase.action,
            databasePhaseContainsPool: databasePhase.has("PoolDatabase"),
            storedOriginResolved: isResolved(node.state.props.origin),
            candidateOriginResolved: isResolved(
              node.action === "noop" ? node.state.props.origin : node.props.origin,
            ),
            dependencies: dependencies(connection, next).sort(),
            budgetAction: plan.resources.RuntimeDatabaseBudget.action,
            migrationAction: plan.resources.Migrations.action,
            databasePhaseContainsMigrations: databasePhase.has("Migrations"),
            databasePhaseContainsBudget: databasePhase.has("RuntimeDatabaseBudget"),
            refusal,
          };
          if (!change) {
            yield* Apply.apply(plan);
            const after = yield* read();
            assert.deepEqual(after.props, before.props);
            return {
              ...result,
              resolvedOriginEqual: true,
              resolvedConfigEqual: true,
              connectionWrites,
              commandRuns,
            };
          }
          return {
            ...result,
            resolvedOriginEqual: null,
            resolvedConfigEqual: null,
            connectionWrites,
            commandRuns,
          };
        }),
        next,
      ),
    );
  }).pipe(Effect.provideContext(stack.services));
