import { Effect, Schema } from "effect";
import type { StateService } from "alchemy/State/State";
import { openEnvelope } from "../../src/pool/token.ts";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { readOnlyProbeFetch } from "./probe-network.ts";
import type { BaselineRead } from "./baseline-controller.ts";

export type RehearsalCounters = {
  state: {
    getVersion: number;
    listStacks: number;
    listStages: number;
    get: number;
    getReplacedResources: number;
    list: number;
    getOutput: number;
    writeAttempts: number;
  };
  fetch: {
    stateGetAttempts: number;
    stateGetCompleted: number;
    providerGetAttempts: number;
    providerGetCompleted: number;
    edgePreviewAuthPosts: number;
    edgePreviewAuthCompleted: number;
    blockedMutationAttempts: number;
  };
  runtime: {
    declaredInspectReads: number;
    declaredHealthReads: number;
    inspectPostDispatches: number;
    inspectControllerDigests: string[];
    inspectStatusClasses: number[];
    healthGetDispatches: number;
    healthStatusClasses: number[];
    refusedNonInspectCommands: number;
    refusedOtherRequests: number;
  };
};

export const createRehearsalCounters = (): RehearsalCounters => ({
  state: {
    getVersion: 0,
    listStacks: 0,
    listStages: 0,
    get: 0,
    getReplacedResources: 0,
    list: 0,
    getOutput: 0,
    writeAttempts: 0,
  },
  fetch: {
    stateGetAttempts: 0,
    stateGetCompleted: 0,
    providerGetAttempts: 0,
    providerGetCompleted: 0,
    edgePreviewAuthPosts: 0,
    edgePreviewAuthCompleted: 0,
    blockedMutationAttempts: 0,
  },
  runtime: {
    declaredInspectReads: 0,
    declaredHealthReads: 0,
    inspectPostDispatches: 0,
    inspectControllerDigests: [],
    inspectStatusClasses: [],
    healthGetDispatches: 0,
    healthStatusClasses: [],
    refusedNonInspectCommands: 0,
    refusedOtherRequests: 0,
  },
});

const counted = <A, E>(record: () => void, effect: Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    record();
    return effect;
  });

/** Counts logical State reads and makes every State mutation fail before the backing service. */
export function countReadOnlyState(state: StateService, counters: RehearsalCounters): StateService {
  const writeRefused = () => {
    counters.state.writeAttempts++;
    return Effect.die(new BarrierRefusal("release-rehearsal-state-write-refused"));
  };
  return {
    id: state.id,
    getVersion: () => counted(() => counters.state.getVersion++, state.getVersion()),
    listStacks: () => counted(() => counters.state.listStacks++, state.listStacks()),
    listStages: (stack) => counted(() => counters.state.listStages++, state.listStages(stack)),
    get: (request) => counted(() => counters.state.get++, state.get(request)),
    getReplacedResources: (request) =>
      counted(() => counters.state.getReplacedResources++, state.getReplacedResources(request)),
    list: (request) => counted(() => counters.state.list++, state.list(request)),
    getOutput: (request) => counted(() => counters.state.getOutput++, state.getOutput(request)),
    set: writeRefused,
    delete: writeRefused,
    deleteStack: writeRefused,
    setOutput: writeRefused,
  };
}

const isStateGet = (url: URL) =>
  url.pathname === "/version" ||
  url.pathname === "/state/stacks" ||
  url.pathname.startsWith("/state/stacks/");

const isEdgePreviewAuthPost = (request: Request, accountId: string) => {
  const url = new URL(request.url);
  const prefix = `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/`;
  return (
    request.method === "POST" &&
    url.origin === "https://api.cloudflare.com" &&
    new Set([
      `${prefix}subdomain/edge-preview`,
      `${prefix}scripts/alchemy-state-store/edge-preview`,
    ]).has(url.pathname)
  );
};

/** Counts parent-process HTTP reads while retaining the existing GET-only probe guard. */
export function countReadOnlyProbeFetch(
  accountId: string,
  counters: RehearsalCounters,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const guarded = readOnlyProbeFetch(accountId, fetcher);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    let completed: (() => void) | undefined;
    if (request.method === "GET") {
      if (isStateGet(url)) {
        counters.fetch.stateGetAttempts++;
        completed = () => counters.fetch.stateGetCompleted++;
      } else {
        counters.fetch.providerGetAttempts++;
        completed = () => counters.fetch.providerGetCompleted++;
      }
    } else if (isEdgePreviewAuthPost(request, accountId)) {
      counters.fetch.edgePreviewAuthPosts++;
      completed = () => counters.fetch.edgePreviewAuthCompleted++;
    } else {
      counters.fetch.blockedMutationAttempts++;
    }
    const response = await guarded(request);
    completed?.();
    return response;
  };
}

const safeStatusClass = (status: number) => Math.floor(status / 100);
const command = Schema.Struct({
  action: Schema.Literal("inspect"),
  controllerCode: ControllerCode,
  at: Schema.Number.check(Schema.isInt()),
  expiresAt: Schema.Number.check(Schema.isInt()),
});

/** Only the old controller's signed inspect plus direct recovery GET may cross this bridge. */
export function countReadOnlyBaselineConnect(
  connect: NonNullable<import("../pool-operations.ts").PoolOperationsTarget["connect"]>,
  input: {
    expectedControllerCode?: typeof ControllerCode.Type;
    key: string;
    counters: RehearsalCounters;
  },
): NonNullable<import("../pool-operations.ts").PoolOperationsTarget["connect"]> {
  return async (path) => {
    const platform = await connect(path);
    const service = platform.env.POOL_OPERATIONS;
    return {
      ...platform,
      env: {
        ...platform.env,
        POOL_OPERATIONS: {
          fetch: async (request) => {
            const url = new URL(request.url);
            if (request.method === "POST" && url.pathname === runtimeHandoffPath && !url.search) {
              let payload: unknown;
              try {
                const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
                  await request.clone().json(),
                );
                payload = await openEnvelope(input.key, runtimeHandoffCommandPrefix, body.envelope);
              } catch {
                payload = undefined;
              }
              const action =
                typeof payload === "object" && payload !== null
                  ? Reflect.get(payload, "action")
                  : undefined;
              if (action !== "inspect") {
                input.counters.runtime.refusedNonInspectCommands++;
                throw new BarrierRefusal("release-rehearsal-runtime-command-refused", "PoolWorker");
              }
              let decoded: typeof command.Type;
              try {
                decoded = Schema.decodeUnknownSync(command, {
                  onExcessProperty: "error",
                })(payload);
              } catch {
                input.counters.runtime.refusedOtherRequests++;
                throw new BarrierRefusal("release-rehearsal-runtime-command-invalid", "PoolWorker");
              }
              if (
                (input.expectedControllerCode !== undefined &&
                  canonical(decoded.controllerCode) !== canonical(input.expectedControllerCode)) ||
                decoded.expiresAt <= decoded.at ||
                decoded.expiresAt - decoded.at > 60_000
              ) {
                input.counters.runtime.refusedOtherRequests++;
                throw new BarrierRefusal(
                  "release-rehearsal-runtime-identity-refused",
                  "PoolWorker",
                );
              }
              input.counters.runtime.inspectPostDispatches++;
              input.counters.runtime.inspectControllerDigests.push(
                digest(canonical(decoded.controllerCode)),
              );
              let response: Response;
              try {
                response = await service.fetch(request);
              } catch (error) {
                throw error;
              }
              input.counters.runtime.inspectStatusClasses.push(safeStatusClass(response.status));
              return response;
            }
            if (
              request.method === "GET" &&
              url.pathname === runtimeRecoveryPath &&
              !url.search &&
              !request.body
            ) {
              input.counters.runtime.healthGetDispatches++;
              const response = await service.fetch(request);
              input.counters.runtime.healthStatusClasses.push(safeStatusClass(response.status));
              return response;
            }
            input.counters.runtime.refusedOtherRequests++;
            throw new BarrierRefusal("release-rehearsal-runtime-request-refused", "PoolWorker");
          },
        },
      },
    };
  };
}

export function countBaselineReadDeclaration(
  counters: RehearsalCounters,
): (call: BaselineRead) => Promise<void> {
  return async (call) => {
    if (call.method === "POST" && call.path === runtimeHandoffPath && call.action === "inspect") {
      counters.runtime.declaredInspectReads++;
      return;
    }
    if (call.method === "GET" && call.path === runtimeRecoveryPath && call.action === undefined) {
      counters.runtime.declaredHealthReads++;
      return;
    }
    counters.runtime.refusedOtherRequests++;
    throw new BarrierRefusal("release-rehearsal-runtime-read-refused", "PoolWorker");
  };
}
