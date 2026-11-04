import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

/** Native MCP on the saved GitLab instance, independently of the REST catalog. */
export const gitlabMcp: Addition = {
  entry: {
    id: "gitlab-mcp",
    package: source.package,
    name: "GitLab MCP",
    description: "Use the MCP tools enabled on GitLab.com or your own GitLab instance.",
    auth: [
      { method: "oauth", kind: "oauth2", label: "Sign in" },
      { method: "token", kind: "secrets", label: "Fine-grained personal access token" },
    ],
    icons: [],
    source: "apps/gitlab-mcp.json",
  },
  source,
};
