/**
 * Every name a rename touches. Deploys and checks read these values. `public/` holds the logo
 * files, and `check:build` fails when they and this config disagree.
 */
export const brand = {
  /** What the tools service calls itself in pages, emails, OAuth and MCP metadata. */
  name: "Signalbox",
  /** The mark, served by the router from `public/`. Signalbox's own logo, rendered at 192px. */
  logo: "/brand/logo.png",
  host: "app.signalbox.run",
  zone: "signalbox.run",
  /** The MCP entry clients and setup add. The tools service derives it from `name`. */
  mcpServerName: "signalbox",
  /** The Google and GitHub OAuth apps created at account setup carry this name. */
  oauthAppName: "Signalbox",
  /** Sign-in codes and invitations come from no-reply at this domain, under `name`. */
  emailDomain: "auth.signalbox.run",
  /**
   * The brand's own docs, privacy and terms pages, as absolute URLs. The tools service links
   * each one only when it is set; the router also sends those paths here.
   */
  links: {
    docs: null as string | null,
    privacy: null as string | null,
    terms: null as string | null,
  },
} as const;

export const deployment = {
  stage: "production",
  sourceNamespace: "basalt-production-apps",
  databaseName: "basalt",
  databaseRegion: "eu-central",
  databaseClusterSize: "PS_5",
  placementRegion: "aws:eu-central-1",
} as const;

export const appHosting = {
  enabled: false,
  origin: "https://apps.signalbox.run",
  zone: "signalbox.run",
} as const;
