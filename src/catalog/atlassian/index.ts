import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };
import { atlassianIcons } from "./logo.ts";

/** The app is source data served by the Catalog Worker, never imported by the tools API. */
export function atlassianAddition(): Addition {
  return {
    entry: {
      id: "atlassian",
      package: source.package,
      name: "Atlassian",
      description:
        "Search, create and update Jira issues, service desk requests and Confluence pages with your Atlassian account.",
      auth: [{ method: "oauth", kind: "oauth2" }],
      icons: [...atlassianIcons],
      source: "apps/atlassian.json",
    },
    source,
  };
}
