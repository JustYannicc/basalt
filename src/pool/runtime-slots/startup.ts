import { SlotRefused, sameControllerCode, type ControllerCode } from "./contract.ts";
import { decodeAdmissionProof, type StartupWitness } from "./admission-proof.ts";
import { startupOptionsFingerprint, type RuntimeConfiguration } from "./configuration.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { RuntimeWitnessStore, WitnessRecord } from "./witness-store.ts";
import { createPoolLifecycle } from "../runtime.worker.ts";
import { LaunchLedger, launchTokenHash } from "../launch-ledger.ts";
import type { PoolStatus } from "../lifecycle.ts";

function runtimeLaunch(ctx: RuntimeState, record: WitnessRecord) {
  const target = record.authorization.target;
  const binding = {
    controllerId: target.controllerId,
    instanceId: target.instanceId,
    applicationId: target.applicationId,
    versionId: target.applicationVersion,
    imageHash: target.imageInput,
    imageDigest: target.imageDigest,
  };
  // The admitted manifest is the release epoch. Applied settings have their own launch witness.
  const ledger = new LaunchLedger(ctx.storage, async () => ({
    ...binding,
    releaseEpoch: record.authorization.manifestDigest,
  }));
  return { ledger, binding };
}

/** The durable launch intent and applied-settings witness both precede the actual start call. */
export async function startRuntime(
  ctx: RuntimeState,
  code: ControllerCode,
  store: RuntimeWitnessStore,
  record: WitnessRecord,
  configuration: RuntimeConfiguration,
  signal: AbortSignal,
  afterWitness?: (witness: StartupWitness) => Promise<void>,
  assertStart: () => void = () => {},
) {
  const target = record.authorization.target;
  const { ledger, binding } = runtimeLaunch(ctx, record);
  await store.retainAlarmTarget(target);
  const lifecycle = await createPoolLifecycle(
    ctx,
    {
      POOL_DATABASE_URL: configuration.databaseUrl,
      POOL_MANAGEMENT_KEY: configuration.managementKey,
      POOL_APP_SIGNING_KEY: configuration.signingKey,
      POOL_APP_SIGNING_KEY_PREVIOUS: configuration.previousSigningKey,
      POOL_IMAGE_HASH: configuration.imageInput,
      ...(configuration.claudeQuotaDiagnostic ? { POOL_CLAUDE_QUOTA_DIAGNOSTIC: "true" } : {}),
      ...(configuration.homePeerOrdinal !== undefined
        ? { POOL_HOME_PEER_ORDINAL: String(configuration.homePeerOrdinal) }
        : {}),
    },
    {
      ledger,
      binding,
      assertStart: () => {
        signal.throwIfAborted();
        assertStart();
      },
      beforeStart: async (launch, options) => {
        signal.throwIfAborted();
        decodeAdmissionProof(record.authorization);
        if (!sameControllerCode(record.authorization.controllerCode, code))
          throw new SlotRefused("identity");
        const fingerprint = await startupOptionsFingerprint(options);
        if (fingerprint !== record.authorization.configurationFingerprint)
          throw new SlotRefused("identity");
        const witness: StartupWitness = {
          operationId: record.authorization.operationId,
          manifestDigest: record.authorization.manifestDigest,
          target,
          configurationFingerprint: fingerprint,
          launch: {
            operationId: launch.operationId,
            generation: launch.generation,
            tokenHash: await launchTokenHash(launch.token),
          },
        };
        await store.put(target, { ...record, witness });
        await afterWitness?.(witness);
        signal.throwIfAborted();
        assertStart();
        await store.read(target);
      },
    },
  );
  await lifecycle.warm();
}

export function verifyRuntimeLaunch(ctx: RuntimeState, record: WitnessRecord, status: PoolStatus) {
  return runtimeLaunch(ctx, record).ledger.verify(status);
}
