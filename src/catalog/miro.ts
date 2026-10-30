import source from "./miro.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

/** Full REST API carry from the pinned official package. */
export const miroSource = source;

export function withMiroCapabilities(feed: Feed): Feed {
  return { ...feed, apps: feed.apps.map((entry): FeedEntry => {
    if (entry.id !== "miro") return entry;
    if (entry.package !== miroSource.package) throw new Error("Miro catalog package changed");
    return {
      ...entry,
      description: "Miro board content, team and organization administration, exports, and audit APIs; some require Enterprise and Company Admin.",
      auth: [
        { method: "oauth", kind: "oauth2", label: "Connect your Miro account" },
        { method: "token", kind: "secrets", label: "Advanced: access token" },
      ],
    };
  }) };
}
