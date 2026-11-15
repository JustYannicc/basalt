import type { SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";

export function runtimeApplicationFixture(target: SlotTarget) {
  return {
    id: target.applicationId,
    name: `synthetic-${target.applicationId}`,
    account_id: "1".repeat(32),
    version: Number(target.applicationVersion),
    created_at: "2026-11-09T00:00:00Z",
    instances: 0,
    max_instances: 1,
    scheduling_policy: "default",
    constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
    durable_objects: { namespace_id: `namespace-${target.applicationId}` },
    configuration: {
      image: `registry.cloudflare.com/${"1".repeat(32)}/synthetic@${target.imageDigest}`,
      instance_type: "basic",
      environment_variables: [{ name: "SYNTHETIC", value: "synthetic-fixture" }],
      observability: { logs: { enabled: true } },
    },
  };
}

export async function runtimeProviderFixture(target: SlotTarget) {
  const raw = runtimeApplicationFixture(target);
  return {
    accountId: raw.account_id,
    namespaceId: raw.durable_objects.namespace_id,
    applicationConfigDigest: await providerDigest(
      runtimeApplicationSettings(decodeProviderApplication(raw)),
    ),
  };
}
