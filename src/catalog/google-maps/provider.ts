import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import type { ProviderDefinition } from "@executor-js/sdk/core";

const providerName = "Google Maps Routes";
const methodName = "hostedRoutes";
const methodLabel = "Signalbox hosted routes";

const canonicalOrigin = (origin: string) => {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" &&
        isLoopbackHostname(url.hostname)))
  )
    throw new Error("Hosted Routes origin must be a canonical HTTP(S) origin");
  return url;
};

/** Provider identity input shared with the host's account provisioner. */
export const hostedRoutesProviderDefinition = (origin: string): ProviderDefinition => ({
  name: providerName,
  hosts: [canonicalOrigin(origin).host],
  auth: {
    [methodName]: {
      type: "secrets",
      provisioned: true,
      label: methodLabel,
      fields: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          origin: { type: "string", minLength: 1 },
          token: { type: "string", minLength: 1 },
        },
        required: ["origin", "token"],
        additionalProperties: true,
        $defs: {},
      },
      plain: ["origin"],
      request: [
        {
          in: "header",
          name: "authorization",
          value: ["Bearer ", { field: "token" }],
        },
      ],
    },
  },
});

/** The reference stored on the exact rendered Google Maps catalog copy. */
export const hostedRoutesCatalogReference = (origin: string) =>
  `${canonicalOrigin(origin).origin}/catalog/apps/google-maps.json`;
