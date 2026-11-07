import source from "./planetscale.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

/** PlanetScale's carried package: legacy accounts plus a separate scope-aware sign-in provider. */
export const planetscaleSource = source;

const serviceToken = {
  link: {
    label: "Open PlanetScale's service token guide",
    url: "https://planetscale.com/docs/api/reference/service-tokens",
  },
  steps: [
    "In your PlanetScale organization, open Settings, then Service tokens, and create a token.",
    "Grant the organization and database permissions for the tools you need.",
    "Copy the token's ID and the token itself. PlanetScale shows the token only once.",
  ],
  note: "Tools can only use the permissions the token was granted.",
  fields: {
    token: {
      label: "Service token",
      expectedFormat: "Paste SERVICE_TOKEN_ID:SERVICE_TOKEN as one value, without Bearer.",
    },
  },
};

export const planetscaleConnectionGuidance = [
  {
    requirement: "planetscale",
    method: "oauth2",
    alternativeLabel: "Existing OAuth accounts",
    signIn: {
      description: "Keep using PlanetScale OAuth accounts that were already linked.",
      note: "For new OAuth connections, choose Sign in with PlanetScale.",
      details:
        "This method keeps its original permission request and response contract so existing accounts remain linked. New full-access sign-ins use the separate PlanetScale sign-in method.",
    },
  },
  {
    requirement: "planetscaleSignIn",
    method: "signIn",
    alternativeLabel: "Sign in with PlanetScale",
    signIn: {
      description: "Connect your PlanetScale account to use its API tools.",
      note: "Your actual OAuth grant determines which tools are available. PlanetScale still checks each organization and resource.",
      details:
        "The hosted Signalbox app requests the full reviewed scope set. Dynamic registration is a limited fallback when that hosted app is not configured. Keyspaces, safe migrations, cluster settings, service tokens and OAuth applications require a service token.",
    },
    oauthClient: {
      link: {
        label: "Open PlanetScale's OAuth app guide",
        url: "https://planetscale.com/docs/api/reference/oauth",
      },
      steps: [
        "In your PlanetScale organization, open Settings, then OAuth applications, and choose Create new application.",
        "Enter this site's domain and paste the redirect URL shown here.",
        "Select the documented permissions for the tools you need, then choose Save access scopes.",
        "Copy the Client ID and the Client secret, which PlanetScale shows once.",
      ],
      note: "Creating an app accepts PlanetScale's requirements for your organization's privacy policy and terms, so an authorized person must do it.",
      fields: {
        clientId: { expectedFormat: "Use the Client ID, not the application's ID." },
        clientSecret: { expectedFormat: "Use the Client secret PlanetScale showed once." },
      },
    },
  },
  {
    requirement: "planetscale",
    method: "token",
    alternativeLabel: "Use a service token instead",
    credentials: serviceToken,
  },
];

/** Service-token-only operations use a generic missing-section prompt and one-click token form. */
export const planetscaleToolSections = [
  {
    path: "serviceToken",
    title: "PlanetScale service-token tools",
    requirement: "planetscale",
    method: "token",
    description:
      "Keyspaces, safe migrations, cluster settings, service tokens and OAuth applications aren't available through sign-in. Add a service token with those permissions to use them.",
    actionLabel: "Add service token",
  },
];

export function withPlanetScaleAccess(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "planetscale") return entry;
      if (entry.package !== planetscaleSource.package)
        throw new Error("PlanetScale catalog package changed");
      return {
        ...entry,
        auth: [
          { method: "signIn", kind: "oauth2", label: "Sign in with PlanetScale" },
          ...entry.auth.filter((method) => !(typeof method === "object" && method !== null && "method" in method && method.method === "signIn")).map((method) =>
          typeof method === "object" &&
          method !== null &&
          "method" in method &&
          method.method === "oauth2"
            ? { ...method, label: "Existing PlanetScale OAuth" }
            : typeof method === "object" &&
                method !== null &&
                "method" in method &&
                method.method === "signIn"
              ? { ...method, label: "Sign in with PlanetScale" }
              : method,
        ),
        ],
        connectionGuidance: planetscaleConnectionGuidance,
        toolSections: planetscaleToolSections,
      };
    }),
  };
}
