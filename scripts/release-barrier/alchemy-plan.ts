import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import { havePropsChanged } from "alchemy/Diff";
import { hashDirectory } from "alchemy/Command/Memo";
import type { ExecProps } from "alchemy/Command/Exec";
import {
  WorkerUploadHook,
  type PreparedWorkerUpload,
} from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import type { Worker } from "alchemy/Cloudflare";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, FileSystem, Path } from "effect";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { BarrierRefusal } from "./manifest.ts";

const workerType = "Cloudflare.Worker";
const existing = (node: Plan.Apply) =>
  node.state?.status === "created" ||
  node.state?.status === "updated" ||
  (node.state?.status === "updating" && !node.state.adopting && !!node.state.old);
function refuse(reason: string, worker?: string): never {
  throw new BarrierRefusal(reason, worker);
}

/** No live resource lifecycle runs during shadow preparation. Commands expose only their real output contract. */
export function assertSupportedPlan(plan: Plan.Plan) {
  if (plan.selectedFqns || plan.destroy) refuse("partial-or-destroy-plan");
  if (
    Object.keys(plan.deletions).length ||
    Object.keys(plan.actionDeletions).length ||
    Object.keys(plan.actions).length
  )
    refuse("resource-removal-or-action");
  for (const [fqn, node] of Object.entries(plan.resources)) {
    if (!existing(node) || !["update", "noop"].includes(node.action) || node.renamedFrom?.length)
      refuse("new-or-unsettled-resource", fqn);
    if (node.resource.Type === workerType) {
      const props = node.resource.Props as Worker["Props"];
      if (props.namespace != null || props.preview != null || props.version != null)
        refuse("unsupported-worker-mode", fqn);
    } else if (
      node.resource.Type !== "Command.Exec" &&
      node.resource.Type !== "Command.Build" &&
      node.action !== "noop"
    ) {
      // Returning an old image/application attribute would freeze the wrong PoolWorker input.
      refuse("unsupported-resource-update", fqn);
    }
    if (node.resource.Type === "Command.Build" && node.resource.LogicalId !== "Site")
      refuse("unsupported-build-command", fqn);
  }
}

export const preparePlan = (stack: CompiledStack, plan: Plan.Plan) =>
  Effect.gen(function* () {
    assertSupportedPlan(plan);
    const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const captured = new Map<string, PreparedWorkerUpload>();
    const inputs = new Map<string, { news: unknown; bindings: unknown }>();
    const builds = new Map<string, object>();
    const resources: Plan.Plan["resources"] = {};
    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (node.action !== "update" && node.action !== "noop")
        return refuse("unsupported-plan", fqn);
      if (
        node.state.status !== "created" &&
        node.state.status !== "updated" &&
        node.state.status !== "updating"
      )
        return refuse("unsettled-resource", fqn);
      const provider = node.provider;
      let reconcile: typeof provider.reconcile;
      if (node.resource.Type === workerType) {
        reconcile = (input) =>
          provider.reconcile(input).pipe(
            Retry.none,
            Effect.provideService(WorkerUploadHook, {
              capture: (upload) =>
                Effect.sync(() => {
                  if (!upload.proposed || !upload.previous || !upload.previousSettings)
                    refuse("missing-existing-worker", fqn);
                  captured.set(fqn, upload);
                  inputs.set(fqn, { news: input.news, bindings: input.bindings });
                  return upload.proposed!;
                }),
            }),
          );
      } else if (node.resource.Type === "Command.Exec") {
        reconcile = (input) =>
          Effect.gen(function* () {
            const news = input.news as ExecProps;
            return {
              hash: {
                input:
                  news.memo === false
                    ? undefined
                    : yield* hashDirectory({
                        cwd: news.cwd,
                        memo: news.memo === true ? {} : news.memo,
                      }).pipe(Effect.provideContext(files)),
              },
            };
          });
      } else if (node.resource.Type === "Command.Build") {
        reconcile = (input) => {
          if (input.news.command !== "bun run hosted:cloud:site:build")
            return Effect.sync(() => refuse("unsupported-build-command", fqn));
          return provider.reconcile(input).pipe(
            Effect.tap((output) =>
              Effect.sync(() => {
                builds.set(fqn, output);
              }),
            ),
          );
        };
      } else {
        reconcile = () => Effect.sync(() => refuse("unexpected-preparation-lifecycle", fqn));
      }
      const wrapped = { ...provider, precreate: undefined, reconcile };
      resources[fqn] =
        node.resource.Type === workerType
          ? {
              ...node,
              action: "update",
              props: node.resource.Props,
              state: node.state,
              provider: wrapped,
            }
          : { ...node, provider: wrapped };
    }
    const states = Object.fromEntries(
      Object.entries(plan.resources).map(([fqn, node]) => [fqn, node.state!]),
    );
    const shadow = yield* InMemoryService({ [stack.name]: { [stack.stage]: states } });
    yield* Apply.apply({ ...plan, resources }).pipe(
      Effect.provideService(State, Effect.succeed(shadow)),
    );
    const workers = Object.entries(plan.resources)
      .filter(([, node]) => node.resource.Type === workerType)
      .map(([fqn]) => fqn);
    if (
      !workers.length ||
      captured.size !== workers.length ||
      workers.some((fqn) => !captured.has(fqn))
    )
      refuse("incomplete-worker-coverage");
    return {
      captured,
      inputs,
      builds,
      stack: stack.name,
      stage: stack.stage,
      original: plan,
      plan: { ...plan, resources },
    };
  });

export type PreparedPlan = Effect.Success<ReturnType<typeof preparePlan>>;

/** Commit native state and run deferred checks only after every exact version has activated. */
export const finishPlan = (
  prepared: PreparedPlan,
  activated: ReadonlyMap<string, Worker["Attributes"]>,
  databaseFqns: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const resources: Plan.Plan["resources"] = {};
    for (const [fqn, node] of Object.entries(prepared.plan.resources)) {
      if (databaseFqns.has(fqn)) {
        const current = yield* state.get({ stack: prepared.stack, stage: prepared.stage, fqn });
        if (!current || !(current.status === "created" || current.status === "updated"))
          refuse("database-state-unsettled", fqn);
        resources[fqn] = { ...node, action: "noop", state: current };
      } else if (node.resource.Type === workerType || node.resource.Type === "Command.Build") {
        resources[fqn] = {
          ...node,
          provider: {
            ...node.provider,
            reconcile: (input) =>
              Effect.sync(() => {
                if (
                  node.resource.Type === workerType &&
                  havePropsChanged(prepared.inputs.get(fqn), {
                    news: input.news,
                    bindings: input.bindings,
                  })
                )
                  refuse("activation-input-drift", fqn);
                const result =
                  node.resource.Type === workerType ? activated.get(fqn) : prepared.builds.get(fqn);
                if (!result) refuse("missing-prepared-output", fqn);
                return result!;
              }),
          },
        };
      } else {
        // Restore the original provider: preparation's Command.Exec was deliberately pure.
        resources[fqn] = { ...node, provider: prepared.original.resources[fqn]!.provider };
      }
    }
    return yield* Apply.apply({ ...prepared.plan, resources });
  });
