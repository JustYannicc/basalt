import { brand } from "../../../brand.ts";
import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

/** The app is source data served by the Catalog Worker, never imported by the tools API. */
export function atlassianAddition(ready = false): Addition {
  const availability = ready ? "" : "Atlassian is not set up yet. ";
  return {
    entry: {
      id: "atlassian",
      package: source.package,
      name: "Atlassian",
      description: "Search Confluence and read Jira issues with your own Atlassian account.",
      auth: [{ method: "oauth", kind: "oauth2" }],
      icons: [],
      source: "apps/atlassian.json",
      connectionNotices: [{
        providerName: "Atlassian",
        message: `${availability}${brand.name}'s Atlassian app is unreviewed. Atlassian shows an unreviewed-app warning before consent. You connect your own account for read access to Confluence and Jira. Your site's permissions and app access policies still apply.`,
      }],
    },
    source,
  };
}
