import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };
import provenance from "./provenance.json" with { type: "json" };
import { atlassianIcons } from "./logo.ts";

/** Keep retained specifications on the catalog's own origin, including self-hosted catalogs. */
export function atlassianAddition(origin: string): Addition {
  const files = source.files.map((file) => {
    if (file.path !== "api-coverage.json") return file;
    let content = file.content;
    for (const name of ["jira", "serviceManagement"] as const) {
      const api = provenance.capabilities.apis[name];
      content = content.replace(
        JSON.stringify(api.url),
        JSON.stringify(new URL(`/catalog/openapi/atlassian/${api.sha256}.json`, origin).href),
      );
    }
    return { ...file, content };
  });
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
    source: { ...source, files },
  };
}
