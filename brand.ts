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
  /** Stable ownership survives a product rename; display text and new keys follow the brand. */
  setup: {
    id: "basalt-computer-v1",
    marker: "Signalbox managed computer setup",
    keyPrefix: "sb_",
  },
  /** Hosted OAuth apps created at account setup carry this name. */
  oauthAppName: "Signalbox",
  /** Sign-in codes and invitations come from no-reply at this domain, under `name`. */
  emailDomain: "auth.signalbox.run",
  /**
   * The brand's own docs, privacy and terms pages, as absolute URLs. The tools service links
   * each one only when it is set; the router also sends those paths here. `source` is where the
   * code is published, linked from the dashboard sidebar; a fork points it at its own repository,
   * or sets it to null to show no link.
   */
  links: {
    docs: null as string | null,
    privacy: "https://signalbox.run/privacy" as string | null,
    terms: "https://signalbox.run/terms" as string | null,
    source: "https://github.com/JustYannicc/basalt" as string | null,
  },
  /**
   * The public site at the zone's apex: home, privacy, terms and legal notice. The operator is
   * named by entity and region only, with one contact address for every request.
   */
  site: {
    operator: "Signalbox",
    region: "Zurich, Switzerland",
    email: "info@signalbox.run",
    /** When the legal pages last changed, as they print it. */
    updated: "29 October 2026",
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
  enabled: true,
  scheme: "opaque" as "nested" | "opaque",
  embedded: true,
  /** Custom-domain product hosts need a route bypass ahead of the wildcard app route. */
  bypassHosts: ["app.signalbox.run"],
  origin: "https://signalbox.run",
  zone: "signalbox.run",
} as const;
