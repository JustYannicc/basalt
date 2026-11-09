import source from "./elevenlabs.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

export const elevenlabsSource = source;

/** The official MCP server offers sign-in beside the retained full REST API. */
export function withElevenLabsSignIn(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "elevenlabs") return entry;
      if (entry.package !== elevenlabsSource.package)
        throw new Error("ElevenLabs catalog package changed");
      return {
        ...entry,
        auth: [
          { method: "oauth", kind: "oauth2", label: "Sign in with ElevenLabs" },
          ...entry.auth,
        ],
        // Sign-in reaches the MCP server's tools; an API key reaches the full REST API.
        requirementTools: { signIn: "ElevenLabs MCP tools", elevenlabs: "ElevenLabs API tools" },
      };
    }),
  };
}
