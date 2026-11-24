import type { Feed, FeedEntry } from "./feed.ts";

/**
 * Tailscale's API takes an OAuth client from the person's own tailnet (client credentials). Its
 * authorization-code OAuth apps only serve users of the tailnet that owns them, so there is no
 * sign-in to offer here; the guide names the method plainly and says where its two values come from.
 */
export const tailscaleConnectionGuidance = [
  {
    requirement: "tailscale",
    method: "oauth",
    methodLabel: "OAuth client",
    oauthClient: {
      link: {
        label: "Open Trust credentials in Tailscale",
        url: "https://console.tailscale.com/admin/settings/trust-credentials",
      },
      steps: [
        "On the Trust credentials page of the Tailscale admin console, select Credential, then OAuth. Only an Owner or Admin can grant every scope.",
        "For full read and write access, choose the all scope with Write. Narrower scopes work for narrower use, as long as they can read devices (devices:core:read), which the connection check uses. Write on devices:core or auth_keys also asks for tags.",
        "Select Generate credential, then copy the client ID and secret. Tailscale shows the secret only once.",
      ],
    },
  },
];

export function withTailscaleGuidance(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map((entry): FeedEntry => {
      if (entry.id !== "tailscale" || entry.package !== "@executor.sh/tailscale") return entry;
      return { ...entry, connectionGuidance: tailscaleConnectionGuidance };
    }),
  };
}
