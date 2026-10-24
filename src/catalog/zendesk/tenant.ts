const subdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Zendesk tenant configuration is exactly one lowercase DNS label. */
export const isZendeskSubdomain = (value: string): boolean => subdomainPattern.test(value);
