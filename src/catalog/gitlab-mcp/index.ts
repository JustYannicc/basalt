import { gitlabMcpIcons } from "./logo.ts";
import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

/** Native MCP on the saved GitLab instance, independently of the REST catalog. */
export const gitlabMcp: Addition = {
  entry: {
    id: "gitlab-mcp",
    package: source.package,
    name: "GitLab MCP",
    description: "Search projects, manage issues and review merge requests on your GitLab instance.",
    auth: [
      { method: "oauth", kind: "oauth2", label: "Sign in" },
      { method: "token", kind: "secrets", label: "Fine-grained personal access token" },
    ],
    icons: gitlabMcpIcons,
    source: "apps/gitlab-mcp.json",
  },
  source,
};
