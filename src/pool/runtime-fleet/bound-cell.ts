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
  const remote = (value: SlotTarget): RuntimeStub => {
    if (!sameTarget(value, target)) throw new SlotRefused("identity");
    // Same-stub E-order keeps an earlier model send ahead of the endpoint drain.
    const runtimeStub = (retained ??= input.remote(value));
    return {
      fetch: async (request) => {
        try {
          return await runtimeStub.fetch(request);
        } catch (error) {
          // Native exceptions poison this stub. Future calls reconnect; this call never retries.
          if (retained === runtimeStub) retained = undefined;
          throw error;
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
