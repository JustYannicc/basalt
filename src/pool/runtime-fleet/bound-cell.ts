import {
  SlotRefused,
  sameTarget,
  type ControllerCode,
  type SlotTarget,
} from "../runtime-slots/contract.ts";
import { RuntimeHandoff, type HandoffEnvironment } from "../runtime-slots/integration.ts";
import type { ControllerState } from "../runtime-slots/runtime-state.ts";
import { BoundSlotDriver, type RuntimeStub } from "../runtime-slots/transport.ts";
import { runtimeConfiguration } from "../runtime-slots/configuration.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import type { FleetApplication } from "./configuration.ts";
import { runtimeCellState } from "./cell-state.ts";
import type { SlotStorage } from "../runtime-slots/storage.ts";
import { FleetAdmission } from "./admission.ts";
import { FleetHandoffCell } from "./cell.ts";
import { EndpointTrace } from "./endpoint-trace.ts";

interface Input {
  ctx: ControllerState;
  env: HandoffEnvironment;
  code: ControllerCode;
  target: SlotTarget;
  application: FleetApplication;
  provider: RuntimeProviderReader;
  authorizeStart?(transaction: SlotStorage): Promise<void>;
  remote(target: SlotTarget): RuntimeStub;
  wrap(response: Response, lease: NativeStreamLease): Response;
}

export function boundFleetCell(input: Input) {
  const { application, target } = input;
  if (
    application.applicationId !== target.applicationId ||
    application.applicationVersion !== target.applicationVersion ||
    application.imageDigest !== target.imageDigest ||
    application.imageInput !== target.imageInput
  )
    throw new SlotRefused("identity");
  const env = {
    ...input.env,
    POOL_RUNTIME_APPLICATION_ID: application.applicationId,
    POOL_IMAGE_HASH: application.imageInput,
    POOL_HOME_PEER_ORDINAL: String(target.homePeerOrdinal),
  };
  let retained: RuntimeStub | undefined;
  const cellId = crypto.randomUUID();
  let sequence = 0;
  const stubs = new WeakMap<RuntimeStub, number>();
  const acquire = (value: SlotTarget) => {
    const runtimeStub = input.remote(value);
    stubs.set(runtimeStub, ++sequence);
    return runtimeStub;
  };
  const remote = (value: SlotTarget): RuntimeStub => {
    if (!sameTarget(value, target)) throw new SlotRefused("identity");
    // Same-stub E-order keeps an earlier model send ahead of the endpoint drain.
    const runtimeStub = (retained ??= acquire(value));
    return {
      fetch: async (request) => {
        const trace = new EndpointTrace(request, target.slotId, cellId);
        let result: unknown;
        const health =
          request.method === "POST" &&
          new URL(request.url).pathname === "/health" &&
          !request.headers.has("X-Signalbox-Runtime-Identity")
            ? request.clone()
            : undefined;
        const send = async (runtimeStub: RuntimeStub, forwarded: Request) => {
          try {
            return await trace.send(stubs.get(runtimeStub)!, () => runtimeStub.fetch(forwarded));
          } catch (error) {
            if (retained === runtimeStub) retained = undefined;
            throw error;
          }
        };
        try {
          try {
            const response = await send(runtimeStub, request);
            result = response;
            return response;
          } catch (error) {
            trace.eligible =
              !!health &&
              error instanceof Error &&
              !("overloaded" in error && error.overloaded === true) &&
              (("disconnected" in error && error.disconnected === true) ||
                ("retryable" in error && error.retryable === true));
            if (!trace.eligible || !health) throw error;
            // Only this read precedes model dispatch. Reconnect once within its original signal.
            health.signal.throwIfAborted();
            trace.reconnected = true;
            const replacement = (retained ??= acquire(value));
            trace.reconnectAcquired = true;
            const response = await send(replacement, health);
            result = response;
            return response;
          }
        } catch (error) {
          result = error;
          throw error;
        } finally {
          trace.finish(result);
          if (health && !health.bodyUsed) void health.body?.cancel().catch(() => {});
        }
      },
    };
  };
  const handoff = new RuntimeHandoff(
    runtimeCellState(input.ctx, target.slotId, input.authorizeStart),
    env,
    input.code,
    {
      remote,
      wrap: input.wrap,
    },
  );
  const admission = new FleetAdmission({
    handoff,
    application,
    configuration: runtimeConfiguration(env),
    code: input.code,
    provider: input.provider,
    key: env.POOL_DEPLOYMENT_KEY ?? "",
  });
  return new FleetHandoffCell({
    handoff,
    driver: new BoundSlotDriver(remote),
    admission,
    application,
    provider: input.provider,
  });
}
