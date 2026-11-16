import { Effect } from "effect";
import type { StateService } from "alchemy/State/State";
import { observationStoreFqn } from "./observation-store-contract.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

const scope = { stack: "basalt", stage: "production" };
const target = { ...scope, fqn: observationStoreFqn };
/** A single-node apply cannot delete undeclared fleet resources or replace the stack output. */
export function observationStoreState(state: StateService, writable: boolean): StateService {
  const refuse = () => Effect.die(new Error("Observation store operation cannot write this state"));
  return {
    ...state,
    get: (request) => {
      sameProvisioningValue("observationStore.state.target", target, request);
      return state.get(request);
    },
    list: (request) => {
      sameProvisioningValue("observationStore.state.scope", scope, request);
      return state.get(target).pipe(Effect.map((row) => (row ? [observationStoreFqn] : [])));
    },
    getReplacedResources: (request) => {
      sameProvisioningValue("observationStore.state.scope", scope, request);
      return Effect.succeed([]);
    },
    set: (request) => {
      sameProvisioningValue("observationStore.state.target", target, {
        stack: request.stack,
        stage: request.stage,
        fqn: request.fqn,
      });
      return writable ? state.set(request) : refuse();
    },
    delete: refuse,
    deleteStack: refuse,
    setOutput: (request) => {
      sameProvisioningValue("observationStore.state.scope", scope, {
        stack: request.stack,
        stage: request.stage,
      });
      sameProvisioningValue("observationStore.state.output", undefined, request.value);
      return writable ? Effect.succeed(undefined) : refuse();
    },
  };
}
