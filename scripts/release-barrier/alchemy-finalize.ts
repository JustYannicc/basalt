import * as Apply from "alchemy/Apply";
import type * as Plan from "alchemy/Plan";
import type { Worker, ContainerApplication } from "alchemy/Cloudflare";
import { havePropsChanged, stripUnresolved } from "alchemy/Diff";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import type { PreparedPlan } from "./alchemy-plan.ts";
import { workerActivationInputs } from "./activation-inputs.ts";
import { BarrierRefusal } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";

const workerType = "Cloudflare.Worker";
function refuse(reason: string, worker?: string): never {
  throw new BarrierRefusal(reason, worker);
}

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
        const result =
          node.resource.Type === workerType
            ? activated.get(fqn)
            : (activatedContainers.get(fqn) ??
              prepared.builds.get(fqn) ??
              prepared.checkedCommands.get(fqn));
        // Apply exposes saved cycle attributes to peers before reconciliation.
        // Seed the verified outputs so transient baseline inputs never reappear.
        const finalized =
          result && prepared.plan.cycleMembers.has(fqn) && node.action === "update"
            ? { ...node, state: { ...node.state, attr: result } }
            : node;
        resources[fqn] = {
          ...finalized,
          provider: {
            ...node.provider,
            reconcile: (input) =>
              Effect.sync(() => {
                const current =
                  node.resource.Type === workerType
                    ? workerActivationInputs(input.news, input.bindings)
                    : { news: input.news, bindings: input.bindings };
                if (prepared.inputs.has(fqn) && havePropsChanged(prepared.inputs.get(fqn), current))
                  throw new BarrierRefusal("activation-input-drift", fqn, {
                    fqn,
                    type: node.resource.Type,
                    changed: changedProps(
                      stripUnresolved(prepared.inputs.get(fqn)),
                      stripUnresolved(current),
                    ),
                  });
                if (!result) refuse("missing-prepared-output", fqn);
                return result;
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
