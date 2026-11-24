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

/**
 * Lists a runtime's instance as production does once its container has stopped: still under
 * state=active, as inactive. Returns the restore for the previous fetch.
 */
export function listStoppedAsInactive(runtime: {
  target: SlotTarget;
  ctx: { container: { running: boolean } };
}) {
  const raw = runtimeApplicationFixture(runtime.target);
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      runtime.ctx.container.running ||
      !url.pathname.endsWith(`/applications/${raw.id}/instances-v2`)
    )
      return previous(input, init);
    return Response.json({
      success: true,
      errors: [],
      result: [
        {
          id: runtime.target.instanceId,
          application_id: raw.id,
          status: { state: "inactive" },
          image: raw.configuration.image,
        },
      ],
      result_info: { next_page_token: "" },
    });
  };
  return () => (globalThis.fetch = previous);
}
