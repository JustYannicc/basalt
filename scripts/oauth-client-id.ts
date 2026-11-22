/**
 * Whether an OAuth client ID is a recognizable client secret. Client IDs are otherwise opaque, so
 * only secret prefixes that no client ID of the same provider starts with are refused. The hosted
 * deploy check imports this file, and upstream preparation copies it unchanged into the SDK, whose
 * authorization refuses the same IDs. Keep it free of imports.
 */
export const clientIdLooksLikeSecret = (clientId: string): boolean => {
  // PlanetScale's OAuth secret prefix is distinct from its pscale_app_ client IDs.
  // Google's documented example: https://codelabs.developers.google.com/generate_creatives_google_ads
  const value = clientId.trim();
  return value.startsWith("pscale_app_secret_") || value.startsWith("GOCSPX-");
};
