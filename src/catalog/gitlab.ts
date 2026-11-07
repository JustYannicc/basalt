import source from "./gitlab.json" with { type: "json" };
import type { Feed, FeedEntry } from "./feed.ts";

/** GitLab's site-aware package, carried until its self-managed support is published upstream. */
export const gitlabSource = source;

// Links name GitLab.com pages; the connect form opens them on the account's selected instance.
const policy =
  "Your administrator can turn off personal access tokens, personal OAuth apps, automatic registration or the MCP server. If every option is off, ask them to allow one.";

/** GitLab's one app: MCP sign-in first, with full REST API access as explicit alternatives. */
export const gitlabConnectionGuidance = [
  {
    requirement: "signIn",
    method: "mcp",
    alternativeLabel: "Sign in with GitLab instead",
    signIn: {
      description: "Sign in to use GitLab's MCP tools on this instance.",
      note: "Your access follows your GitLab role and your instance's settings.",
      details:
        "Sign-in grants the mcp scope only. It reaches the tools this instance's MCP server lists, such as searching and working with issues and merge requests, and none of the REST API tools. For the full REST API, use a personal access token or your own GitLab OAuth app instead.",
    },
    oauthClient: {
      link: {
        label: "Open GitLab applications",
        url: "https://gitlab.com/-/user_settings/applications",
      },
      steps: [
        "Choose Add new application and name it.",
        "Paste the redirect URL shown here, clear Confidential and select the mcp scope.",
        "Save the application and copy its Application ID.",
      ],
      note: policy,
      fields: { clientId: { expectedFormat: "Use GitLab's Application ID." } },
    },
  },
  {
    requirement: "gitlab",
    method: "token",
    alternativeLabel: "Use a personal access token for the full API",
    credentials: {
      link: {
        label: "Open GitLab personal access tokens",
        url: "https://gitlab.com/-/user_settings/personal_access_tokens",
      },
      steps: [
        "Choose Generate token, then Legacy token. Name it and set an expiry date.",
        "Select the api scope for full REST API access.",
        "Create the token and copy it now. GitLab shows it only once.",
      ],
      note: policy,
      fields: {
        token: {
          label: "Personal access token",
          expectedFormat: "Paste the token only, without Bearer.",
        },
      },
    },
  },
  {
    requirement: "gitlab",
    method: "oauth",
    alternativeLabel: "Use your own GitLab app for the full API",
    oauthClient: {
      link: {
        label: "Open GitLab applications",
        url: "https://gitlab.com/-/user_settings/applications",
      },
      steps: [
        "Choose Add new application and name it.",
        "Paste the redirect URL shown here and keep Confidential selected.",
        "Select the api scope and save the application.",
        "Copy the Application ID and Secret into the fields below.",
      ],
      note: policy,
      fields: {
        clientId: { expectedFormat: "Use GitLab's Application ID." },
        clientSecret: { expectedFormat: "Use the Secret GitLab shows after you save the app." },
      },
    },
  },
];

export function withGitLabInstances(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "gitlab") return entry;
      if (entry.package !== gitlabSource.package) throw new Error("GitLab catalog package changed");
      return {
        ...entry,
        description:
          "Projects, merge requests, issues and pipelines on GitLab.com or your own GitLab server.",
        auth: [
          { method: "mcp", kind: "oauth2", label: "Sign in with GitLab" },
          { method: "oauth", kind: "oauth2", label: "OAuth 2.0" },
          { method: "token", kind: "secrets", label: "Personal access token" },
        ],
        connectionGuidance: gitlabConnectionGuidance,
      };
    }),
  };
}
