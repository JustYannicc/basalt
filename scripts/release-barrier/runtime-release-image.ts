import { Config, Effect, Redacted, Schema } from "effect";
import { ImageUpdateIntent } from "../../src/pool/runtime-fleet/image-update.ts";
import { runtimeApplicationConfigDigest } from "./runtime-slot-provider-proof.ts";
import type { RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import type { RuntimeImagePhase, FleetImageResource } from "./runtime-image-phase.ts";
import type { FrozenContainer, ContainerAttributes } from "./container.ts";
import { readServingObservation } from "./serving-observation.ts";
import { BarrierRefusal } from "./manifest.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

/** A selected fleet primary already consumes the only slot; no drain can create overlap capacity. */
export async function assertReleaseImageCapacity(client: RuntimeReleaseClient) {
  const [selected, fleet] = await Promise.all([client.inspect(), client.fleet()]);
  const active = selected.selection?.active.target;
  if (
    fleet.permission?.configuration.maximum === 1 &&
    active &&
    active.instanceId !== active.controllerId
  )
    throw new BarrierRefusal("runtime-release-capacity-raise-cap-required", "PoolWorker", {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      changed: [{ path: "fleet.maximum", old: 1, new: 2 }],
      why: [
        "Raise the fleet cap explicitly to at least 2 before upgrading a selected non-legacy primary.",
      ],
    });
  return fleet.permission;
}

/** Provider mutation remains in the ordinary barrier; this owns only its inactive-application admission. */
export const runtimeReleaseImage = (input: {
  resource: FleetImageResource;
  client: RuntimeReleaseClient;
  read(): RuntimeReleaseRecord;
  save(value: RuntimeReleaseRecord): Promise<void>;
}) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const prepare = async (container: FrozenContainer) => {
      const permission = await assertReleaseImageCapacity(input.client);
      const record = input.read();
      if (container.id !== input.resource)
        throw new BarrierRefusal("runtime-release-image-target", container.id);
      const baseline = permission?.configuration.applications.find(
        (app) => app.applicationId === container.baseline.applicationId,
      );
      if (!baseline || !permission)
        throw new BarrierRefusal("runtime-release-image-baseline-missing", container.id);
      let update = record.update;
      if (!update) {
        update = Schema.decodeUnknownSync(ImageUpdateIntent)({
          operationId: `image-${record.candidate}`,
          configurationDigest: permission.digest,
          baseline,
          imageDigest: container.imageDigest,
          imageInput: container.inputHash,
        });
        await input.save({ ...record, update });
      }
      sameProvisioningValue(
        "runtime-release.image-publication",
        {
          applicationId: update.baseline.applicationId,
          imageDigest: update.imageDigest,
          imageInput: update.imageInput,
        },
        {
          applicationId: container.baseline.applicationId,
          imageDigest: container.imageDigest,
          imageInput: container.inputHash,
        },
      );
      const response = await input.client.call({
        action: "image-inspect",
        operationId: update.operationId,
      });
      const retained = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.NullOr(
            Schema.Struct({
              intent: ImageUpdateIntent,
              phase: Schema.String,
            }),
          ),
        }),
      )(response).result;
      if (retained) {
        sameProvisioningValue("runtime-release.image-retained-intent", update, retained.intent);
        if (retained.phase === "prepared" || retained.phase === "completed") return;
        if (retained.phase !== "checking")
          throw new BarrierRefusal("runtime-release-image-cancelled", container.id);
      }
      const prepared = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            intent: ImageUpdateIntent,
            phase: Schema.Literal("prepared"),
          }),
        }),
      )(await input.client.call({ action: "image-prepare", update }, true)).result;
      sameProvisioningValue("runtime-release.image-prepared-intent", update, prepared.intent);
    };
    const verify = async (container: FrozenContainer, observed: ContainerAttributes) => {
      if (
        container.id !== input.resource ||
        container.configuration.image !== observed.configuration.image ||
        container.imageDigest !== observed.configuration.image.split("@")[1] ||
        observed.activeRolloutId
      )
        throw new BarrierRefusal("runtime-release-image-readback-mismatch", container.id);
      const provider = await readServingObservation(
        {
          accountId: observed.accountId,
          applicationId: observed.applicationId,
          version: observed.version,
          digest: container.imageDigest,
        },
        Redacted.value(token),
        AbortSignal.timeout(15_000),
      );
      if (
        provider.instances.length ||
        provider.activeRolloutId ||
        provider.version !== observed.version ||
        provider.digest !== container.imageDigest
      )
        throw new BarrierRefusal("runtime-release-inactive-image-not-empty", container.id);
      if (!input.read().update) await prepare(container);
      const update = input.read().update!;
      if (
        update.baseline.applicationId !== observed.applicationId ||
        update.imageInput !== container.inputHash ||
        (String(observed.version) === update.baseline.applicationVersion &&
          (container.imageDigest !== update.baseline.imageDigest ||
            runtimeApplicationConfigDigest(observed) !== update.baseline.applicationConfigDigest))
      )
        throw new BarrierRefusal("runtime-release-image-version-not-confirmed", container.id);
      await input.client.health();
    };
    return {
      resource: input.resource,
      deferVerification: true,
      prepare,
      verify,
    } satisfies RuntimeImagePhase;
  });
