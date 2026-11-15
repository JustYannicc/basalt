export const catalogAcceptanceApps = [
  { entry: "aws", package: "aws", sourcePath: "src/catalog/aws/source.json" },
  { entry: "canva", package: "@executor.sh/canva", sourcePath: "src/catalog/canva.json" },
  { entry: "clerk", package: "@executor.sh/clerk", sourcePath: "src/catalog/clerk.json" },
  {
    entry: "confluence",
    package: "@executor.sh/confluence",
    sourcePath: "src/catalog/confluence.json",
  },
  {
    entry: "elevenlabs",
    package: "@executor.sh/elevenlabs",
    sourcePath: "src/catalog/elevenlabs.json",
  },
  {
    entry: "gitlab-mcp",
    package: "@signalbox/gitlab-mcp",
    sourcePath: "src/catalog/gitlab-mcp/source.json",
  },
  { entry: "gitlab", package: "@executor.sh/gitlab", sourcePath: "src/catalog/gitlab.json" },
  {
    entry: "google-maps",
    package: "@executor.sh/google-maps",
    sourcePath: "src/catalog/google-maps/source.json",
  },
  { entry: "jira", package: "@executor.sh/jira", sourcePath: "src/catalog/jira.json" },
  { entry: "miro", package: "@executor.sh/miro", sourcePath: "src/catalog/miro.json" },
  { entry: "neon", package: "@executor.sh/neon", sourcePath: "src/catalog/neon.json" },
  { entry: "notion", package: "@executor.sh/notion", sourcePath: "src/catalog/notion.json" },
  { entry: "obsidian", package: "obsidian", sourcePath: "src/catalog/obsidian/source.json" },
  { entry: "plaid", package: "@executor.sh/plaid", sourcePath: "src/catalog/plaid.json" },
  {
    entry: "planetscale",
    package: "@executor.sh/planetscale",
    sourcePath: "src/catalog/planetscale.json",
  },
  {
    entry: "provider-anthropic",
    package: "provider-anthropic",
    sourcePath: "src/catalog/provider-apps/anthropic.json",
  },
  {
    entry: "provider-antigravity",
    package: "provider-antigravity",
    sourcePath: "src/catalog/provider-apps/antigravity.json",
  },
  {
    entry: "provider-cloudflare",
    package: "provider-cloudflare",
    sourcePath: "src/catalog/provider-apps/cloudflare.json",
  },
  {
    entry: "provider-devin",
    package: "provider-devin",
    sourcePath: "src/catalog/provider-apps/devin.json",
  },
  {
    entry: "provider-gemini",
    package: "provider-gemini",
    sourcePath: "src/catalog/provider-apps/gemini.json",
  },
  {
    entry: "provider-jev",
    package: "provider-jev",
    sourcePath: "src/catalog/provider-apps/jev.json",
  },
  {
    entry: "provider-kimi",
    package: "provider-kimi",
    sourcePath: "src/catalog/provider-apps/kimi.json",
  },
  {
    entry: "provider-meta",
    package: "provider-meta",
    sourcePath: "src/catalog/provider-apps/meta.json",
  },
  {
    entry: "provider-openai",
    package: "provider-openai",
    sourcePath: "src/catalog/provider-apps/openai.json",
  },
  {
    entry: "provider-openrouter",
    package: "provider-openrouter",
    sourcePath: "src/catalog/provider-apps/openrouter.json",
  },
  {
    entry: "provider-vertex",
    package: "provider-vertex",
    sourcePath: "src/catalog/provider-apps/vertex.json",
  },
  {
    entry: "provider-xai",
    package: "provider-xai",
    sourcePath: "src/catalog/provider-apps/xai.json",
  },
  { entry: "sentry", package: "@executor.sh/sentry", sourcePath: "src/catalog/sentry.json" },
  { entry: "slack", package: "@executor.sh/slack", sourcePath: "src/catalog/slack.json" },
  { entry: "spotify", package: "@executor.sh/spotify", sourcePath: "src/catalog/spotify.json" },
  { entry: "vercel", package: "@executor.sh/vercel", sourcePath: "src/catalog/vercel.json" },
  { entry: "workos", package: "@executor.sh/workos", sourcePath: "src/catalog/workos.json" },
  {
    entry: "zoho-people",
    package: "@signalbox/zoho-people",
    sourcePath: "src/catalog/zoho-people/source.json",
  },
] as const;

export type AcceptanceApp = (typeof catalogAcceptanceApps)[number];
