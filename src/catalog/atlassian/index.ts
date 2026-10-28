import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

/** The app is source data served by the Catalog Worker, never imported by the tools API. */
export function atlassianAddition(): Addition {
  return {
    entry: {
      id: "atlassian",
      package: source.package,
      name: "Atlassian",
      description: "Search Confluence and read Jira issues with your own Atlassian account.",
      auth: [{ method: "oauth", kind: "oauth2" }],
      icons: [],
      source: "apps/atlassian.json",
    },
    source,
  };
}
