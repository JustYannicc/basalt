export const zendeskOpenapiSource = String.raw`import type { OpenapiToolNamesOptions } from "apps/openapi";

// The Support API spec declares basicAuth, but the saved provider account is OAuth.
export function optionsFor(site: string) {
  return {
    source: { url: "https://developer.zendesk.com/zendesk/oas.yaml" },
    allowedOrigin: site,
    baseUrl: site,
    securitySchemes: { basicAuth: { type: "http", scheme: "bearer" } },
    methods: {
      oauth: [{ scheme: "basicAuth", field: "access_token", part: "value", prefix: "" }],
    },
    oauth: [],
  } satisfies OpenapiToolNamesOptions;
}
`;
