import source from "./workos.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

export const workosSource = source;

export function withWorkOSSignIn(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "workos") return entry;
      if (entry.package !== workosSource.package) throw new Error("WorkOS catalog package changed");
      return {
        ...entry,
        auth: [{ method: "oauth", kind: "oauth2", label: "Sign in with WorkOS" }, ...entry.auth],
        connectionGuidance: [
          {
            requirement: "signIn",
            method: "oauth",
            alternativeLabel: "Sign in instead",
            signIn: {
              description: "Sign in to manage your WorkOS workspace.",
              note: "Your access follows your WorkOS role and your team's settings.",
              details:
                "WorkOS's management tools for organizations, users, connections and more. WorkOS keeps secret creation, impersonation and some account actions out of these tools. An API key connects the existing WorkOS API tools.",
            },
          },
          {
            requirement: "workos",
            method: "apiKey",
            alternativeLabel: "Use an API key instead",
            credentials: {
              steps: [
                "Select the project and environment you want to connect.",
                "Open API Keys. Copy the staging key, or create a production key and copy it once.",
              ],
              link: { label: "Open WorkOS API keys", url: "https://dashboard.workos.com/api-keys" },
              note: "The key accesses that environment. For production, choose its key rather than a staging key.",
              fields: { token: { label: "API key", expectedFormat: "Starts with sk_." } },
            },
          },
        ],
      };
    }),
  };
}
