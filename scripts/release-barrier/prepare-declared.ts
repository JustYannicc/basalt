import * as Plan from "alchemy/Plan";
import type { CompiledStack } from "alchemy/Stack";
import { Effect } from "effect";
import type { DeployStackOptions } from "./deploy-stack.ts";
import type { BucketProvider } from "./declared-buckets.ts";
import type { ClassProvider } from "./declared-class-contract.ts";
import { prepareDeclaredStorage } from "./declared-bucket-plan.ts";
import { preparePlan } from "./alchemy-plan.ts";
import { expandDeclaredClasses } from "./declared-classes.ts";
import { assertSupportedPlan } from "./plan-admission.ts";
import { BarrierRefusal } from "./manifest.ts";

/** Replan only after an observed expansion changed the live baseline and native namespace mapping. */
export const prepareDeclaredRelease = (
  stack: CompiledStack,
  evaluated: Plan.Plan,
  options: DeployStackOptions,
  buckets: BucketProvider,
  classes: ClassProvider,
) =>
  Effect.gen(function* () {
    const scope = { stack: stack.name, stage: stack.stage };
    const attempt = (source: Plan.Plan) =>
      Effect.gen(function* () {
        assertSupportedPlan(source, new Map(), options.declarations);
        const { plan, buckets: declaredBuckets } = yield* prepareDeclaredStorage(
          source,
          options.declarations,
          scope,
          buckets,
          options.declaredReadiness,
        );
        for (const bucket of declaredBuckets.values())
          yield* Effect.promise(() =>
            options.declared!({
              bucket,
              lifecycle: bucket.resume ? "creating" : "planned",
              outcome: bucket.resume ? "acknowledged" : "not-started",
            }),
          );
        const prepared = yield* preparePlan(
          stack,
          plan,
          options.io?.namespace,
          options.io?.container,
          options.publication,
          options.declarations,
          declaredBuckets,
        );
        return { plan, prepared, declaredBuckets };
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
    );
    if (expanded) {
      result = yield* attempt(yield* Plan.make(stack));
      if (
        yield* expandDeclaredClasses(
          result.plan,
          result.prepared,
          options.declarations,
          scope,
          options.candidate,
          classes,
          options.expansion,
        )
      )
        throw new BarrierRefusal("declared-class-expansion-did-not-settle");
    }
    return result;
  });
