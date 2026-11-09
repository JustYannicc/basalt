import * as Plan from "alchemy/Plan";
import type { CompiledStack } from "alchemy/Stack";
import { Effect } from "effect";
import type { DeployStackOptions } from "./deploy-stack.ts";
import type { PreparedBucket, BucketProvider } from "./declared-buckets.ts";
import type { ClassProvider } from "./declared-class-contract.ts";
import type { PreparedD1, D1Provider } from "./declared-d1-types.ts";
import type { DeclaredStorage } from "./declared-bucket-plan.ts";
import { prepareDeclaredStorage } from "./declared-bucket-plan.ts";
import { preparePlan } from "./alchemy-plan.ts";
import { expandDeclaredClasses } from "./declared-classes.ts";
import { assertSupportedPlan } from "./plan-admission.ts";
import { observeWorkerBaselines } from "./worker-baselines.ts";
import { BarrierRefusal } from "./manifest.ts";

/** Replan only after an observed expansion changed the live baseline and native namespace mapping. */
export const prepareDeclaredRelease = (
  stack: CompiledStack,
  evaluated: Plan.Plan,
  options: DeployStackOptions,
  buckets: BucketProvider,
  classes: ClassProvider,
  d1: D1Provider,
) =>
  Effect.gen(function* () {
    const scope = { stack: stack.name, stage: stack.stage };
    const attempt = (source: Plan.Plan, frozen?: DeclaredStorage) =>
      Effect.gen(function* () {
        assertSupportedPlan(source, new Map(), options.declarations);
        const {
          plan,
          buckets: declaredBuckets,
          databases: declaredDatabases,
        } = yield* prepareDeclaredStorage(
          source,
          options.declarations,
          scope,
          buckets,
          options.declaredReadiness,
          { d1, frozen },
        );
        const resources = [
          ...[...declaredBuckets.values()].map((bucket) => ({ bucket })),
          ...[...declaredDatabases.values()].map((database) => ({ database })),
        ];
        for (const resource of resources) {
          const storage = "bucket" in resource ? resource.bucket : resource.database;
          yield* Effect.promise(() =>
            options.declared!({
              ...resource,
              lifecycle: storage.resume ? "creating" : "planned",
              outcome: storage.resume ? "acknowledged" : "not-started",
            }),
          );
        }
        const declaredStorage = new Map<string, PreparedBucket | PreparedD1>([
          ...declaredBuckets,
          ...declaredDatabases,
        ]);
        const prepared = yield* preparePlan(
          stack,
          plan,
          options.io?.namespace,
          options.io?.container,
          options.publication,
          options.declarations,
          declaredStorage,
        );
        const workerBaselines = yield* observeWorkerBaselines(prepared.captured, stack, options.io);
        return {
          plan,
          prepared,
          declaredBuckets,
          declaredDatabases,
          declaredStorage,
          workerBaselines,
        };
      });
    let result = yield* attempt(evaluated);
    const expanded = yield* expandDeclaredClasses(
      result.plan,
      result.prepared,
      options.declarations,
      scope,
      options.candidate,
      classes,
      options.expansion,
      result.workerBaselines,
    );
    if (expanded) {
      result = yield* attempt(yield* Plan.make(stack), {
        buckets: result.declaredBuckets,
        databases: result.declaredDatabases,
      });
      if (
        yield* expandDeclaredClasses(
          result.plan,
          result.prepared,
          options.declarations,
          scope,
          options.candidate,
          classes,
          options.expansion,
          result.workerBaselines,
        )
      )
        throw new BarrierRefusal("declared-class-expansion-did-not-settle");
    }
    return result;
  });
