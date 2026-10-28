import source from "./slack.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

/** The maintained Slack package, carried until its user-token contribution is published. */
export const slackSource = source;

export function withSlackUserAuth(feed: Feed): Feed {
  return { ...feed, apps: feed.apps.map((entry): FeedEntry => {
    if (entry.id !== "slack") return entry;
    if (entry.package !== slackSource.package) throw new Error("Slack catalog package changed");
    // The carried app drops the bot install, which needs a person's own Slack app and a workspace install.
    return { ...entry, auth: [
      { method: "user", kind: "oauth2", label: "Connect as yourself" },
      ...(entry.auth as { method?: string }[]).filter(method => method.method !== "oauth"),
    ] };
  }) };
}
