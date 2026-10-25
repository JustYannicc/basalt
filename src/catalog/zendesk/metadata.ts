export interface ZendeskMarketplaceMetadata {
  readonly organizationId: string;
  readonly appId: string;
}

const identifier = /^[a-zA-Z0-9_-]{1,128}$/;

/** Assigned publisher metadata is public configuration, never a credential or tenant selector. */
export function zendeskMarketplaceMetadata(
  organizationId?: string,
  appId?: string,
): ZendeskMarketplaceMetadata | undefined {
  if (!organizationId && !appId) return undefined;
  if (!organizationId || !appId || !identifier.test(organizationId) || !identifier.test(appId))
    throw new Error("Zendesk Marketplace metadata needs both assigned organization and app IDs.");
  return { organizationId, appId };
}
