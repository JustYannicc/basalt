import source from "./miro.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

/** Board-only adaptation of the pinned official package. */
export const miroSource = source;

export function withMiroBoards(feed: Feed): Feed {
  return { ...feed, apps: feed.apps.map((entry): FeedEntry => {
    if (entry.id !== "miro") return entry;
    if (entry.package !== miroSource.package) throw new Error("Miro catalog package changed");
    return {
      ...entry,
      description: "Miro boards, board content and board members. Board read/write scopes work on all plans.",
      auth: [
        { method: "oauth", kind: "oauth2", label: "Connect your Miro account" },
        { method: "token", kind: "secrets", label: "Advanced: access token" },
      ],
    };
  }) };
}
