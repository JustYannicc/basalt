import source from "./gitlab.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

/** GitLab's site-aware package, carried until its self-managed support is published upstream. */
export const gitlabSource = source;

export function withGitLabInstances(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "gitlab") return entry;
      if (entry.package !== gitlabSource.package) throw new Error("GitLab catalog package changed");
      return {
        ...entry,
        description:
          "GitLab projects, merge requests, issues and the REST API from GitLab.com or a self-managed instance.",
        auth: [
          { method: "oauth", kind: "oauth2", label: "OAuth 2.0" },
          { method: "token", kind: "secrets", label: "Personal access token" },
        ],
      };
    }),
  };
}
