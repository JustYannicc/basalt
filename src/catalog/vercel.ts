import source from "./vercel.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

export const vercelSource = source;

/** Sign-in uses the official MCP server; API tokens retain the full REST API. */
export function withVercelSignIn(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "vercel") return entry;
      if (entry.package !== vercelSource.package) throw new Error("Vercel catalog package changed");
      return {
        ...entry,
        auth: [{ method: "oauth", kind: "oauth2", label: "Sign in with Vercel" }, ...entry.auth],
        // Sign-in reaches the MCP server's tools; an access token reaches the full REST API.
        requirementTools: { signIn: "Vercel MCP tools", vercel: "Vercel REST API tools" },
      };
    }),
  };
}
