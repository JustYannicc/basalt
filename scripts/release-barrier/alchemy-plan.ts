import { withOperation } from "./operation-failure.ts";
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
import type { ContainerApplication } from "alchemy/Cloudflare";
import { ContainerPublicationHook } from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, FileSystem, Path } from "effect";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { BarrierRefusal } from "./manifest.ts";
import { admitSourceNamespace, commandPhase } from "./commands.ts";
import { cloudflareArtifactsApi } from "../ensure-artifacts.ts";
import {
  stageContainer,
  inspectContainer,
  type StagedContainer,
  type FrozenContainer,
  type BaselineNormalization,
} from "./container.ts";
import { imagePlanReasons } from "./plan-reasons.ts";
import { assertSupportedPlan, newVerification } from "./plan-admission.ts";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import type { PreparedD1 } from "./declared-d1-types.ts";
import type { PreparedBucket } from "./declared-buckets.ts";
export { assertSupportedPlan } from "./plan-admission.ts";

const workerType = "Cloudflare.Worker";
function refuse(reason: string, worker?: string): never {
  throw new BarrierRefusal(reason, worker);
}

export const preparePlan = (
  stack: CompiledStack,
  plan: Plan.Plan,
  namespaceApi = cloudflareArtifactsApi,
  inspect = inspectContainer,
  recordPublication?: (
    container: FrozenContainer,
    normalization?: BaselineNormalization,
  ) => Promise<void>,
  declarations?: DeclaredChanges,
  declaredBuckets: ReadonlyMap<string, PreparedBucket | PreparedD1> = new Map(),
) =>
  Effect.gen(function* () {
    assertSupportedPlan(plan, yield* imagePlanReasons(plan), declarations);
    const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const captured = new Map<string, PreparedWorkerUpload>();
    const containers = new Map<string, StagedContainer>();
    const inputs = new Map<string, { news: unknown; bindings: unknown }>();
    const builds = new Map<string, object>();
    const checkedCommands = new Map<string, object>();
    const admissions: (() => Promise<void>)[] = [];
    const databaseCommands = new Set<string>();
    const resources: Plan.Plan["resources"] = {};
    for (const [fqn, node] of Object.entries(plan.resources)) {
      const bucket = declaredBuckets.get(fqn);
      if (bucket) {
        resources[fqn] = node;
        continue;
      }
      if (!newVerification(node) && node.action !== "update" && node.action !== "noop")
        return refuse("unsupported-plan", fqn);
      if (
        !newVerification(node) &&
        node.state?.status !== "created" &&
        node.state?.status !== "updated" &&
        node.state?.status !== "updating"
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
      } else if (node.resource.Type === "Cloudflare.Container" && node.action === "update") {
        const cached =
          node.state?.status === "updating"
            ? node.state.old.attr
            : node.state && "attr" in node.state
              ? node.state.attr
              : undefined;
        reconcile = (input) =>
          provider.reconcile(input).pipe(
            Retry.none,
            Effect.provideService(ContainerPublicationHook, {
              rolloutKind: "full_manual",
              capture: (publication) =>
                Effect.gen(function* () {
                  const staged = yield* stageContainer(
                    publication,
                    input.news as ContainerApplication["Props"],
                    input.olds as ContainerApplication["Props"] | undefined,
                    cached as ContainerApplication["Attributes"],
                    inspect,
                  );
                  if (recordPublication)
                    yield* Effect.tryPromise({
                      try: () => recordPublication(staged.frozen, staged.normalization),
                      catch: (error) => error,
                    });
                  containers.set(fqn, staged);
                  inputs.set(fqn, { news: input.news, bindings: input.bindings });
                  return publication.proposed;
                }),
            }),
          );
      } else if (node.resource.Type === "Command.Exec") {
        reconcile = (input) =>
          Effect.gen(function* () {
            const news = input.news as ExecProps;
            const phase = commandPhase(node.resource.LogicalId, news);
            if (phase === "database") databaseCommands.add(fqn);
            if (phase === "namespace") {
              const check = () => admitSourceNamespace(news, namespaceApi);
              yield* Effect.tryPromise({ try: check, catch: (error) => error });
              admissions.push(check);
              inputs.set(fqn, { news: input.news, bindings: input.bindings });
            }
            const result = {
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
            if (phase === "namespace") checkedCommands.set(fqn, result);
            return result;
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
      const wrapped = {
        ...provider,
        precreate: undefined,
        reconcile: (input: Parameters<typeof reconcile>[0]) =>
          Effect.suspend(() => reconcile(input)).pipe(withOperation(fqn, "prepare-resource")),
      };
      if (
        node.resource.Type === workerType ||
        (node.resource.Type === "Command.Exec" && node.resource.LogicalId === "AppSourceNamespace")
      ) {
        if (!node.state) return refuse("unsettled-resource", fqn);
        if (
          node.state.status !== "created" &&
          node.state.status !== "updated" &&
          node.state.status !== "updating"
        )
          return refuse("unsettled-resource", fqn);
        resources[fqn] = {
          ...node,
          action: "update",
          props: node.resource.Props,
          state: node.state,
          provider: wrapped,
        };
      } else resources[fqn] = { ...node, provider: wrapped };
    }
    const states = Object.fromEntries(
      Object.entries(plan.resources)
        .filter(([, node]) => node.state !== undefined)
        .map(([fqn, node]) => [fqn, node.state!]),
    );
    const shadow = yield* InMemoryService({ [stack.name]: { [stack.stage]: states } });
    yield* Apply.apply({
      ...plan,
      output: declaredBuckets.size ? undefined : plan.output,
      resources: Object.fromEntries(
        Object.entries(resources).filter(([fqn]) => !declaredBuckets.has(fqn)),
      ),
    }).pipe(Effect.provideService(State, Effect.succeed(shadow)));
    const workers = Object.entries(plan.resources)
      .filter(([, node]) => node.resource.Type === workerType)
      .map(([fqn]) => fqn);
    if (
      !workers.length ||
      captured.size !== workers.length ||
      workers.some((fqn) => !captured.has(fqn))
    )
      refuse("incomplete-worker-coverage");
    if (
      Object.entries(plan.resources).some(
        ([fqn, node]) =>
          node.resource.Type === "Cloudflare.Container" &&
          node.action === "update" &&
          !containers.has(fqn),
      )
    )
      refuse("incomplete-container-coverage");
    return {
      captured,
      containers,
      inputs,
      builds,
      checkedCommands,
      admissions,
      databaseCommands,
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
  activatedContainers: ReadonlyMap<string, ContainerApplication["Attributes"]> = new Map(),
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
      } else if (
        node.resource.Type === workerType ||
        prepared.containers.has(fqn) ||
        node.resource.Type === "Command.Build" ||
        prepared.checkedCommands.has(fqn)
      ) {
        resources[fqn] = {
          ...node,
          provider: {
            ...node.provider,
            reconcile: (input) =>
              Effect.sync(() => {
                if (
                  prepared.inputs.has(fqn) &&
                  havePropsChanged(prepared.inputs.get(fqn), {
                    news: input.news,
                    bindings: input.bindings,
                  })
                )
                  refuse("activation-input-drift", fqn);
                const result =
                  node.resource.Type === workerType
                    ? activated.get(fqn)
                    : (activatedContainers.get(fqn) ??
                      prepared.builds.get(fqn) ??
                      prepared.checkedCommands.get(fqn));
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
