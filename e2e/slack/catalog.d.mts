export interface SlackPackageFile {
  readonly path: string;
  readonly content: string;
}

export interface SlackPackage {
  readonly package: string;
  readonly files: readonly SlackPackageFile[];
}

export interface SlackUserMethod {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly userScopes: readonly string[];
  readonly userScope: string;
}

export interface PublishedAppsRelease {
  readonly version: string;
  readonly frameworkProtocol: number;
  readonly integrity: string;
  readonly tarballOrigin: string;
}

export function readSlackPackage(root: string): Promise<SlackPackage>;
export function openapiSpecUrl(source: SlackPackage): string;
export function assertSourceKeepsSlackTools(source: SlackPackage): void;
export function slackUserMethod(source: SlackPackage): SlackUserMethod;
export function inspectPublishedAppsRelease(registryUrl: string, version: string): Promise<PublishedAppsRelease>;
export function localSlackPackage(source: SlackPackage, localOrigin: string, specUrl: string): {
  readonly source: SlackPackage;
  readonly changed: readonly Record<string, string | number>[];
};
