import source from "./plaid.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

export const plaidSource = source;

/** Advertise the native machine grant while retaining the existing REST and browser methods. */
export function withPlaidAccess(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "plaid") return entry;
      if (entry.package !== plaidSource.package) throw new Error("Plaid catalog package changed");
      return {
        ...entry,
        auth: [
          { method: "clientCredentials", kind: "oauth2", label: "Use Production keys for MCP" },
          ...entry.auth.filter(
            (method) =>
              !(
                typeof method === "object" &&
                method !== null &&
                "method" in method &&
                method.method === "clientCredentials"
              ),
          ),
        ],
      };
    }),
  };
}
