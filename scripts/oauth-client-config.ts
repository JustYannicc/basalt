import { clientIdLooksLikeSecret } from "./oauth-client-id.ts";

/** A configuration failure that never retains the supplied credential. */
export class OAuthClientConfigurationError extends Error {
  constructor(provider: string) {
    super(`OAuth client ID looks like a client secret for ${provider}`);
    this.name = "OAuthClientConfigurationError";
  }
}

/** Reject recognizable secrets without imposing a format on opaque OAuth client IDs. */
export function assertOAuthClientId(provider: string, clientId: string | undefined): void {
  if (clientId !== undefined && clientIdLooksLikeSecret(clientId))
    throw new OAuthClientConfigurationError(provider);
}
