import { Config, Effect, Redacted } from "effect";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import {
  ProviderApplicationProof,
  ProviderRuntimeProof,
} from "../../src/pool/runtime-slots/admission-proof.ts";
import { Schema } from "effect";
import { assertContainerImage } from "../deploy-safety/pool-image.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { observeContainer } from "./container-cloudflare.ts";
import type { ContainerAttributes } from "./container.ts";
import { canonical, digest } from "./manifest.ts";
import type { RuntimeHandoffManifest } from "./runtime-slot-manifest.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

export function runtimeApplicationConfigDigest(
  application: Parameters<typeof runtimeApplicationSettings>[0],
) {
  return digest(canonical(runtimeApplicationSettings(application)));
}

const applicationProof = Schema.decodeUnknownSync(ProviderApplicationProof, {
  onExcessProperty: "error",
});
const runtimeProof = Schema.decodeUnknownSync(ProviderRuntimeProof, { onExcessProperty: "error" });
export const readRuntimeProviderProof = (
  manifest: Pick<RuntimeHandoffManifest, "provider" | "target">,
  kind: "application" | "runtime",
  fetcher: Fetcher = fetch,
  now = Date.now,
) =>
  Effect.gen(function* () {
    const observedAt = now();
    const target = {
      accountId: manifest.provider.accountId,
      applicationId: manifest.target.applicationId,
    };
    const before = yield* observeContainer(target, fetcher);
    const prove = (value: ContainerAttributes) => {
      sameProvisioningValue(
        "handoff.provider.account",
        manifest.provider.accountId,
        value.accountId,
      );
      sameProvisioningValue(
        "handoff.provider.application",
        manifest.target.applicationId,
        value.applicationId,
      );
      sameProvisioningValue(
        "handoff.provider.version",
        manifest.target.applicationVersion,
        String(value.version),
      );
      sameProvisioningValue(
        "handoff.provider.namespace",
        manifest.provider.namespaceId,
        value.durableObjects?.namespaceId,
      );
      sameProvisioningValue(
        "handoff.provider.image",
        manifest.target.imageDigest,
        value.configuration.image.split("@")[1],
      );
      sameProvisioningValue(
        "handoff.provider.configuration",
        manifest.provider.applicationConfigDigest,
        runtimeApplicationConfigDigest(value),
      );
      sameProvisioningValue("handoff.provider.rollout", undefined, value.activeRolloutId);
    };
    prove(before);
    let instances: string[] | undefined;
    if (kind === "runtime") {
      const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
      const result = yield* Effect.tryPromise({
        try: () =>
          assertContainerImage(
            { ...target, digest: manifest.target.imageDigest },
            { accountId: target.accountId, apiToken: Redacted.value(token) },
            fetcher,
          ),
        catch: () =>
          provisioningRefusal(
            "runtime-provider-instance-unverified",
            "handoff.provider.instance",
            manifest.target.instanceId,
            "unverified",
          ),
      });
      sameProvisioningValue(
        "handoff.provider.instance",
        manifest.target.instanceId,
        result.instances.find((instance) => instance === manifest.target.instanceId),
      );
      // All siblings passed the same image check; list order is not application drift.
      instances = [...result.instances].sort();
      const after = yield* observeContainer(target, fetcher);
      prove(after);
      sameProvisioningValue("handoff.provider.stableApplication", before, after);
    }
    const value = {
      ...target,
      namespaceId: manifest.provider.namespaceId,
      applicationVersion: String(before.version),
      imageDigest: manifest.target.imageDigest,
      applicationConfigDigest: runtimeApplicationConfigDigest(before),
      observationDigest: digest(
        canonical({ application: before, ...(instances ? { instances } : {}) }),
      ),
      observedAt,
    };
    return kind === "application"
      ? applicationProof(value)
      : runtimeProof({ ...value, instanceId: manifest.target.instanceId });
  });
