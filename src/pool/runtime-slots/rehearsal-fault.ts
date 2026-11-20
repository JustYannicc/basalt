import { RuntimeSlotRecovery } from "./recovery.ts";
import { BoundSlotDriver, runtimeRequest } from "./transport.ts";
import { RuntimeEndpoint, type EndpointEnvironment } from "./endpoint.ts";
import { RuntimeWitnessStore } from "./witness-store.ts";
import { SlotRefused, sameIdentity, type ControllerCode } from "./contract.ts";
import type { ControllerState } from "./runtime-state.ts";
import type { RuntimeSlotStorage } from "./storage.ts";
import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import type { NativeStreamLease } from "../native-streams.ts";

/** Same shape the release tooling accepts; deployment binds the stage only when it matches. */
export const rehearsalStagePattern = /^test-rehearsal-[1-9][0-9]{0,9}$/u;

interface Dependencies {
  ctx: ControllerState;
  env: EndpointEnvironment;
  code: ControllerCode;
  storage: RuntimeSlotStorage;
  provider?: RuntimeProviderReader;
  wrap(response: Response, lease: NativeStreamLease): Response;
}

/**
 * Rehearsal stages only. Production on 19 Nov 2026: one recovery pass read the root container as
 * stopped while it still ran, admitted a restart, wrote its launch witness, and the start never
 * produced a boot. This runs recovery's own pass against a view of the root whose container reads
 * as stopped and refuses every call, so the real container is never started, stopped or signalled.
 */
export async function restartOverRunning({
  ctx,
  env,
  code,
  storage,
  provider,
  wrap,
}: Dependencies) {
  if (!rehearsalStagePattern.test(env.POOL_REHEARSAL_STAGE ?? "") || !provider)
    throw new SlotRefused("selection");
  const container = ctx.container;
  if (!container?.running) throw new SlotRefused("uncertain");
  const { selection } = await storage.inspect();
  const previous = selection?.active.identity;
  if (
    !selection ||
    !previous ||
    previous.instanceId !== ctx.id.toString() ||
    previous.applicationId !== env.POOL_CONTAINER_APPLICATION_ID
  )
    throw new SlotRefused("selection");
  const withheld = (): never => {
    throw new SlotRefused("uncertain");
  };
  const blind: ControllerState = {
    id: ctx.id,
    storage: ctx.storage,
    waitUntil: (work) => ctx.waitUntil(work),
    container: {
      running: false,
      start: withheld,
      destroy: async () => withheld(),
      signal: withheld,
      monitor: async () => withheld(),
      setInactivityTimeout: async () => withheld(),
      getTcpPort: withheld,
    },
  };
  const endpoint = new RuntimeEndpoint(blind, env, "legacy", code, wrap);
  // Its warm fails on the stopped view, as the incident's did; admit and start then run unchanged.
  await new RuntimeSlotRecovery({
    storage,
    driver: new BoundSlotDriver(() => ({ fetch: (request) => runtimeRequest(request, endpoint) })),
    provider,
    code,
    key: env.POOL_DEPLOYMENT_KEY ?? "",
  })
    .recover()
    .catch(() => {});
  const record = await new RuntimeWitnessStore(ctx.storage, env.POOL_DEPLOYMENT_KEY ?? "").retained(
    previous.slotId,
  );
  const after = (await storage.inspect()).selection;
  if (
    !container.running ||
    record?.authorization.kind !== "restart" ||
    record.identity ||
    record.witness?.operationId !== record.authorization.operationId ||
    record.witness.bootId ||
    after?.epoch !== selection.epoch ||
    !sameIdentity(after.active.identity, previous) ||
    after.active.fenced
  )
    throw new SlotRefused("uncertain");
  return { previous, epoch: selection.epoch, operationId: record.authorization.operationId };
}
