import { createElement } from "../../../.upstream/packages/ui/node_modules/react";
import { renderToStaticMarkup } from "../../../.upstream/packages/ui/node_modules/react-dom/server";
import { Exit, Schema } from "effect";
import { Provider, OAuthConnectOptions } from "../../../.upstream/packages/sdk/src/index.ts";
import { AccountForm } from "../../../.upstream/packages/ui/src/implementation/dashboard/account-form.tsx";
import { OAuthFields } from "../../../.upstream/packages/ui/src/implementation/dashboard/oauth-fields.tsx";

const render = ({ machine = true, deferred = false, discovery = false, site = false } = {}) => {
  const provider = Schema.decodeUnknownSync(Provider)({
    id: "prv_synthetic_copy",
    definition: {
      name: "Plaid Dashboard MCP",
      hosts: [site ? "template.example.test" : "api.dashboard.plaid.com"],
      ...(site
        ? {
            site: {
              label: "Workspace",
              origin: "https://template.example.test",
              subdomainOf: "example.test",
            },
          }
        : {}),
      auth: {
        oauth: {
          type: "oauth2",
          response: {
            type: "object",
            properties: { access_token: { type: "string" } },
            required: ["access_token"],
          },
          ...(machine ? { grant: "client_credentials" } : {}),
          ...(discovery
            ? { discover: "https://identity.example.test/mcp" }
            : {
                ...(machine ? {} : { authorizationUrl: "https://identity.example.test/authorize" }),
                tokenUrl: site
                  ? "https://template.example.test/oauth/token"
                  : "https://production.plaid.com/oauth/token",
                scopes: ["mcp:dashboard"],
              }),
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
    },
  });
  const setup = Schema.decodeUnknownSync(OAuthConnectOptions)({
    grant: machine ? "client_credentials" : "authorization_code",
    ...(machine ? {} : { issuer: "https://identity.example.test" }),
    mode: "client-required",
    scopes: ["mcp:dashboard"],
    tokenEndpointAuthMethod: "client_secret_post",
    clients: [],
    resource: { value: null, source: "none" },
  });
  return renderToStaticMarkup(
    createElement(AccountForm, {
      provider,
      ...(site ? { site: "https://customer.example.test" } : {}),
      submitLabel: "Connect",
      submit: async () => Exit.succeed(undefined),
      onSaved: () => {},
      Failure: () => null,
      oauth: (props) =>
        createElement(OAuthFields, {
          ...props,
          providerName: provider.definition.name,
          setup,
          redirectUri: "https://host.example.test/oauth/callback",
          start: async () => Exit.succeed(undefined),
          onAuthorized: () => "done",
          requiresClient: () => false,
          Failure: () => null,
          ...(deferred
            ? {
                deferral:
                  "Use your Plaid Production client ID and secret. Production approval for at least one product is required; this method does not use browser sign-in.",
              }
            : {}),
        }),
    }),
  );
};

console.log(
  JSON.stringify({
    plaid: render({ deferred: true }),
    genericMachine: render(),
    siteMachine: render({ site: true }),
    discoveredMachine: render({ discovery: true }),
    browser: render({ machine: false }),
    deferredBrowser: render({ machine: false, deferred: true }),
  }),
);
