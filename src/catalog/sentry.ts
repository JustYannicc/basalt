import connections from "./sentry.connections.json" with { type: "json" };
import source from "./sentry.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

export const sentrySource = source;

export function withSentryConnections(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "sentry") return entry;
      if (entry.package !== source.package) throw new Error("Sentry catalog package changed");
      return {
        ...entry,
        auth: entry.auth.map((method) => {
          if (typeof method !== "object" || method === null || !("method" in method)) return method;
          if (method.method === "oauth") return { ...method, label: "Sign in for MCP tools" };
          if (method.method === "authToken")
            return { ...method, label: "Personal token for MCP and API" };
          return method;
        }),
        ...connections,
      };
    }),
  };
}
