import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpRequest from "effect/http/HttpClientRequest";
import { canonical, digest } from "./manifest.ts";
import {
  assertProvisioningEnable,
  type ProvisioningEnable,
  type RuntimeProvisioningManifest,
} from "./provisioning-contract.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

function body(request: HttpRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array")
    throw provisioningRefusal(
      "provisioning-create-body-unsupported",
      "application.body",
      "JSON",
      request.body._tag,
    );
  return JSON.parse(new TextDecoder().decode(request.body.body)) as unknown;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The dependency marker is never sent. Only the separately observed namespace may replace it. */
export function applicationTemplateDigest(value: unknown, namespaceId: string) {
  if (
    !object(value) ||
    !object(value.durable_objects) ||
    value.durable_objects.namespace_id !== namespaceId
  )
    throw provisioningRefusal(
      "provisioning-final-attachment-missing",
      "application.attachment",
      namespaceId,
      object(value) ? value.durable_objects : null,
    );
  return digest(
    canonical({
      ...value,
      durable_objects: { ...value.durable_objects, namespace_id: "$namespace-receipt" },
    }),
  );
}

export function expectedApplicationRequest(
  manifest: RuntimeProvisioningManifest,
  namespaceId: string,
) {
  const { props, accountId } = manifest.declaration;
  return {
    name: props.name,
    max_instances: props.maxInstances,
    instances: props.instances,
    scheduling_policy: props.schedulingPolicy,
    constraints: props.constraints,
    durable_objects: { namespace_id: namespaceId },
    configuration: {
      image: props.image,
      instance_type: props.instanceType,
      environment_variables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }],
      observability: props.observability,
    },
  };
}

/** Construct inside the durable one-shot journal operation; SDK adoption/recreate fallbacks are forbidden. */
export function singleFinalCreateClient(
  client: HttpClient.HttpClient,
  manifest: RuntimeProvisioningManifest,
  namespaceId: string,
  enable: ProvisioningEnable | undefined,
  now: () => number,
) {
  let sent = false;
  const collection = `/client/v4/accounts/${manifest.declaration.accountId}/containers/applications`;
  return HttpClient.make((request, url) =>
    Effect.gen(function* () {
      if (
        url.origin !== "https://api.cloudflare.com" ||
        url.pathname !== collection ||
        url.username ||
        url.password
      )
        throw provisioningRefusal(
          "provisioning-provider-operation-refused",
          "application.path",
          collection,
          url.pathname,
        );
      if (request.method === "GET") return yield* client.execute(request);
      if (request.method !== "POST" || sent || url.search)
        throw provisioningRefusal(
          "provisioning-provider-operation-refused",
          "application.method",
          sent ? "no-second-mutation" : "POST",
          request.method,
        );
      assertProvisioningEnable(manifest, enable, now());
      const actual = body(request);
      sameProvisioningValue(
        "application.frozenRequest",
        expectedApplicationRequest(manifest, namespaceId),
        actual,
      );
      sameProvisioningValue(
        "application.templateDigest",
        manifest.applicationTemplateDigest,
        applicationTemplateDigest(actual, namespaceId),
      );
      sent = true;
      return yield* client.execute(request);
    }),
  );
}
