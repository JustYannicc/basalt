/** A configuration failure that never retains the supplied credential. */
export class OAuthClientConfigurationError extends Error {
  constructor(provider: string) {
    super(`OAuth client ID looks like a client secret for ${provider}`);
    this.name = "OAuthClientConfigurationError";
  }
}

/** Reject recognizable secrets without imposing a format on opaque OAuth client IDs. */
export function assertOAuthClientId(provider: string, clientId: string | undefined): void {
  // PlanetScale's OAuth secret prefix is distinct from its pscale_app_ client IDs.
  // Google's documented example: https://codelabs.developers.google.com/generate_creatives_google_ads
  const value = clientId?.trim();
  if (value?.startsWith("pscale_app_secret_") || value?.startsWith("GOCSPX-")) {
    throw new OAuthClientConfigurationError(provider);
  }
}
