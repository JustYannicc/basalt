import source from "./clerk.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

export const clerkSource = source;

export function withClerkSignIn(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "clerk") return entry;
      if (entry.package !== clerkSource.package) throw new Error("Clerk catalog package changed");
      return {
        ...entry,
        auth: [{ method: "oauth", kind: "oauth2", label: "Sign in with Clerk" }, ...entry.auth],
        // Sign-in reaches Clerk's MCP server; a secret key reaches the Backend (REST) API.
        requirementTools: { signIn: "Clerk MCP tools", clerk: "Clerk REST API tools" },
        connectionGuidance: [
          {
            requirement: "signIn",
            method: "oauth",
            alternativeLabel: "Sign in instead",
            signIn: {
              description: "Sign in to manage your Clerk workspace.",
              note: "Choose a workspace and review access. Your Clerk workspace role sets what you can do.",
              details:
                "Clerk's account tools manage applications, users, configuration and domains. They do not cover every Backend API operation or return instance secret keys. A secret key connects the existing Backend API tools.",
            },
          },
          {
            requirement: "clerk",
            method: "apiKey",
            alternativeLabel: "Use an API key instead",
            credentials: {
              steps: [
                "Select your application and Development or Production at the top left.",
                "Open API keys. Under Secret keys, add a key named Signalbox and copy it once.",
              ],
              link: { label: "Open Clerk API keys", url: "https://dashboard.clerk.com/~/api-keys" },
              note: "Use a Secret key, not a Publishable key. Add a new key rather than deleting or rotating one in use.",
              fields: {
                token: {
                  label: "Secret key",
                  expectedFormat:
                    "Starts with sk_test_ for Development or sk_live_ for Production.",
                },
              },
            },
          },
        ],
      };
    }),
  };
}
