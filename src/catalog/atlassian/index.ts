import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

/** The app is source data served by the Catalog Worker, never imported by the tools API. */
export function atlassianAddition(): Addition {
  return {
    entry: {
      id: "atlassian",
      package: source.package,
      name: "Atlassian",
      description:
        "Jira, service management and Confluence reads and writes with your own Atlassian account.",
      auth: [{ method: "oauth", kind: "oauth2" }],
      icons: [],
      source: "apps/atlassian.json",
    },
    source,
  };
}
